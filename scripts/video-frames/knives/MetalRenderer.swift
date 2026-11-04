import Foundation
import MetalKit
import simd

typealias V3 = SIMD3<Float>
typealias V4 = SIMD4<Float>

struct RenderError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct GLTF: Decodable {
    struct Unsupported: Decodable {}
    struct Asset: Decodable { let version: String }
    struct Scene: Decodable { let nodes: [Int] }
    struct Node: Decodable {
        let mesh, skin: Int?
        let children: [Int]?
        let matrix, translation, rotation, scale: [Float]?

        var isBaked: Bool {
            (matrix == nil || matrix == [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1])
                && (translation == nil || translation == [0,0,0])
                && (rotation == nil || rotation == [0,0,0,1] || rotation == [0,0,0,-1])
                && (scale == nil || scale == [1,1,1]) && skin == nil
        }
    }
    struct Mesh: Decodable {
        struct Primitive: Decodable {
            let attributes: [String: Int]
            let indices, material: Int
            let mode: Int?
            let targets: [Unsupported]?
        }
        let primitives: [Primitive]
    }
    struct Material: Decodable {
        struct Map: Decodable { let index: Int; let texCoord: Int?; let scale: Float? }
        struct PBR: Decodable {
            let baseColorTexture, metallicRoughnessTexture: Map
            let baseColorFactor: [Float]?
            let metallicFactor, roughnessFactor: Float?
        }
        let pbrMetallicRoughness: PBR
        let normalTexture: Map
        let alphaMode: String?
        let doubleSided: Bool?
        let occlusionTexture, emissiveTexture: Map?
        let emissiveFactor: [Float]?
    }
    struct View: Decodable { let buffer, byteLength: Int; let byteOffset, byteStride: Int? }
    struct Accessor: Decodable {
        let bufferView, componentType, count: Int
        let byteOffset: Int?
        let type: String
        let sparse: Unsupported?
        let normalized: Bool?
    }
    struct Image: Decodable { let bufferView: Int; let mimeType: String }
    struct Texture: Decodable { let source: Int; let sampler: Int? }
    struct Sampler: Decodable { let wrapS, wrapT, minFilter, magFilter: Int? }
    struct Buffer: Decodable { let byteLength: Int; let uri: String? }
    let asset: Asset
    let scene: Int?
    let scenes: [Scene], nodes: [Node], meshes: [Mesh], materials: [Material], accessors: [Accessor]
    let bufferViews: [View], buffers: [Buffer], images: [Image], textures: [Texture]
    let samplers: [Sampler]?
    let extensionsUsed: [String]?
    let animations, skins: [Unsupported]?

    func primitives() throws -> [Mesh.Primitive] {
        var pending = Array(try scenes.item(scene ?? 0, "scene").nodes.reversed())
        var visited = Set<Int>()
        var result: [Mesh.Primitive] = []
        while let nodeID = pending.popLast() {
            let node = try nodes.item(nodeID, "node")
            guard visited.insert(nodeID).inserted, node.isBaked else {
                throw RenderError("Expected static, identity-transform mesh nodes in a tree")
            }
            if let mesh = node.mesh { result += try meshes.item(mesh, "mesh").primitives }
            pending.append(contentsOf: (node.children ?? []).reversed())
        }
        guard let first = result.first, result.allSatisfy({ $0.material == first.material }) else {
            throw RenderError("Expected one or more triangle primitives sharing one baked material")
        }
        return result
    }
}

extension Array {
    func item(_ index: Int, _ kind: String) throws -> Element {
        guard indices.contains(index) else { throw RenderError("Invalid \(kind) index \(index)") }
        return self[index]
    }
}

struct Vertex {
    var position, normal, tangent, texcoord: V4
}

struct Model {
    let vertices: [Vertex]
    let indices: [UInt32]
    let textures: [MTLTexture]
    let alphaBlend, doubleSided: Bool

    init(url: URL, device: MTLDevice) throws {
        let bytes = try Data(contentsOf: url, options: .mappedIfSafe)
        func word(_ offset: Int) -> Int {
            bytes.withUnsafeBytes { Int($0.loadUnaligned(fromByteOffset: offset, as: UInt32.self)) }
        }
        guard bytes.count >= 28, word(0) == 0x46546C67, word(4) == 2, word(8) == bytes.count,
              word(16) == 0x4E4F534A, word(12) <= bytes.count - 28 else {
            throw RenderError("Expected a GLB 2.0 file with JSON and binary chunks")
        }
        let jsonEnd = 20 + word(12)
        let binary = jsonEnd + 8
        let doc = try JSONDecoder().decode(GLTF.self, from: bytes.subdata(in: 20..<jsonEnd))
        guard word(jsonEnd + 4) == 0x004E4942, word(jsonEnd) == bytes.count - binary,
              doc.asset.version == "2.0", doc.buffers.count == 1, doc.buffers[0].uri == nil,
              (0...word(jsonEnd)).contains(doc.buffers[0].byteLength) else {
            throw RenderError("Expected a single embedded GLB 2.0 buffer")
        }
        guard doc.extensionsUsed?.isEmpty != false, doc.animations?.isEmpty != false, doc.skins?.isEmpty != false else {
            throw RenderError("Bake animations, skins and glTF extensions before rendering")
        }
        func span(_ view: GLTF.View) throws -> Range<Int> {
            let offset = view.byteOffset ?? 0
            let length = doc.buffers[0].byteLength
            guard view.buffer == 0, (0...length).contains(offset), (0...(length - offset)).contains(view.byteLength) else {
                throw RenderError("Buffer view lies outside the embedded buffer")
            }
            return binary + offset..<binary + offset + view.byteLength
        }
        func layout(_ a: GLTF.Accessor, bytesPerElement packed: Int) throws -> (start: Int, stride: Int) {
            let view = try doc.bufferViews.item(a.bufferView, "buffer view")
            let range = try span(view)
            let offset = a.byteOffset ?? 0
            let stride = view.byteStride ?? packed
            guard a.sparse == nil, a.normalized != true, a.count > 0, (packed...252).contains(stride),
                  offset >= 0, offset <= range.count - packed,
                  a.count - 1 <= (range.count - packed - offset) / stride else {
                throw RenderError("Invalid or unsupported accessor layout")
            }
            return (range.lowerBound + offset, stride)
        }
        func attribute(_ p: GLTF.Mesh.Primitive, _ name: String, _ components: Int) throws -> [V4] {
            guard let index = p.attributes[name] else { throw RenderError("Missing " + name) }
            let a = try doc.accessors.item(index, "attribute accessor")
            guard a.componentType == 5126, a.type == "VEC\(components)" else {
                throw RenderError("Expected float32 " + name)
            }
            let (start, stride) = try layout(a, bytesPerElement: components * 4)
            return try bytes.withUnsafeBytes { raw in
                try (0..<a.count).map { i in
                    var v = V4.zero
                    for j in 0..<components {
                        v[j] = raw.loadUnaligned(fromByteOffset: start + i * stride + j * 4, as: Float.self)
                    }
                    guard v.x.isFinite, v.y.isFinite, v.z.isFinite else { throw RenderError("Nonfinite " + name) }
                    return v
                }
            }
        }
        let primitives = try doc.primitives()
        let material = try doc.materials.item(primitives[0].material, "material")
        let pbr = material.pbrMetallicRoughness
        guard [nil, "OPAQUE", "BLEND"].contains(material.alphaMode),
              pbr.baseColorFactor == nil || pbr.baseColorFactor == [1,1,1,1],
              pbr.metallicFactor ?? 1 == 1, pbr.roughnessFactor ?? 1 == 1,
              material.normalTexture.scale ?? 1 == 1,
              material.occlusionTexture == nil, material.emissiveTexture == nil,
              material.emissiveFactor == nil || material.emissiveFactor == [0,0,0] else {
            throw RenderError("Expected a baked metallic/roughness material with default factors and OPAQUE or BLEND alpha")
        }
        alphaBlend = material.alphaMode == "BLEND"
        doubleSided = material.doubleSided ?? false

        var positions: [V4] = [], normals: [V4] = [], uv: [V4] = [], combinedIndices: [UInt32] = []
        for primitive in primitives {
            guard primitive.mode ?? 4 == 4, primitive.targets?.isEmpty != false,
                  primitive.attributes.keys.allSatisfy({ ["POSITION", "NORMAL", "TEXCOORD_0"].contains($0) }) else {
                throw RenderError("Expected baked triangles with POSITION, NORMAL and TEXCOORD_0 only")
            }
            let part = try attribute(primitive, "POSITION", 3)
            let ns = try attribute(primitive, "NORMAL", 3), uvs = try attribute(primitive, "TEXCOORD_0", 2)
            guard ns.count == part.count, uvs.count == part.count,
                  ns.allSatisfy({ simd_length_squared($0.xyz) > 0 && simd_length_squared($0.xyz).isFinite }),
                  positions.count <= Int(UInt32.max) - part.count else {
                throw RenderError("Invalid vertex attributes or combined vertex count")
            }
            let a = try doc.accessors.item(primitive.indices, "index accessor")
            guard a.type == "SCALAR", a.count % 3 == 0,
                  let size = [5121: 1, 5123: 2, 5125: 4][a.componentType] else {
                throw RenderError("Expected unsigned triangle indices")
            }
            let (start, stride) = try layout(a, bytesPerElement: size)
            try bytes.withUnsafeBytes { raw in
                for i in 0..<a.count {
                    let offset = start + i * stride
                    let index: Int
                    switch size {
                    case 1: index = Int(raw[offset])
                    case 2: index = Int(raw.loadUnaligned(fromByteOffset: offset, as: UInt16.self))
                    default: index = Int(raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
                    }
                    guard index < part.count else { throw RenderError("Triangle index lies outside its primitive") }
                    combinedIndices.append(UInt32(positions.count + index))
                }
            }
            positions += part; normals += ns; uv += uvs
        }
        indices = combinedIndices

        var tangents = Array(repeating: V3.zero, count: positions.count)
        var bitangents = tangents
        var centroid = V3.zero
        var projectedArea: Float = 0
        var secondMoment = V3.zero
        for i in stride(from: 0, to: indices.count, by: 3) {
            let a = Int(indices[i]), b = Int(indices[i + 1]), c = Int(indices[i + 2])
            let p0 = positions[a].xyz, p1 = positions[b].xyz, p2 = positions[c].xyz
            let e1 = p1 - p0, e2 = p2 - p0
            let d1 = uv[b] - uv[a], d2 = uv[c] - uv[a]
            let det = d1.x * d2.y - d1.y * d2.x
            if abs(det) > 1e-10 {
                let t = (e1 * d2.y - e2 * d1.y) / det
                let bt = (e2 * d1.x - e1 * d2.x) / det
                for j in [a, b, c] { tangents[j] += t; bitangents[j] += bt }
            }
            let area = abs(simd_cross(e1, e2).z)
            let midpoint = (p0 + p1 + p2) / 3
            centroid += area * midpoint
            projectedArea += area
            secondMoment += area * V3(midpoint.x * midpoint.x, midpoint.y * midpoint.y, midpoint.x * midpoint.y)
        }
        guard projectedArea > 0, projectedArea.isFinite else { throw RenderError("Expected geometry with a nonzero XY projection") }
        centroid /= projectedArea
        secondMoment /= projectedArea
        let covariance = secondMoment - V3(centroid.x * centroid.x, centroid.y * centroid.y, centroid.x * centroid.y)
        let axis = 0.5 * atan2(2 * covariance.z, covariance.x - covariance.y)
        let align = simd_quatf(angle: -axis, axis: V3(0, 0, 1))
        let aligned = positions.map { align.act($0.xyz) }
        let low = aligned.reduce(V3(repeating: .infinity), simd_min)
        let high = aligned.reduce(V3(repeating: -.infinity), simd_max)
        let origin = (low + high) * 0.5
        guard (high.x - low.x) > 0, simd_length(high - low).isFinite else { throw RenderError("Invalid model extent") }
        vertices = aligned.indices.map { i in
            let n = simd_normalize(normals[i].xyz)
            let raw = tangents[i] - n * simd_dot(n, tangents[i])
            let t = simd_length_squared(raw) > 1e-12 ? simd_normalize(raw) : simd_normalize(simd_cross(n, abs(n.y) < 0.95 ? V3(0,1,0) : V3(1,0,0)))
            let sign: Float = simd_dot(simd_cross(n, t), bitangents[i]) < 0 ? -1 : 1
            return Vertex(position: V4((aligned[i] - origin) * (2 / (high.x - low.x)), 1),
                          normal: V4(align.act(n), 0), tangent: V4(align.act(t), sign), texcoord: uv[i])
        }
        let maps = [pbr.baseColorTexture, material.normalTexture, pbr.metallicRoughnessTexture]
        let loader = MTKTextureLoader(device: device)
        textures = try maps.enumerated().map { i, map in
            guard map.texCoord ?? 0 == 0 else { throw RenderError("Expected texture coordinates in UV0") }
            let texture = try doc.textures.item(map.index, "texture")
            if let index = texture.sampler {
                let sampler = try (doc.samplers ?? []).item(index, "sampler")
                guard sampler.wrapS ?? 10497 == 10497, sampler.wrapT ?? 10497 == 10497,
                      sampler.magFilter ?? 9729 == 9729, sampler.minFilter ?? 9987 == 9987 else {
                    throw RenderError("Expected repeat wrapping and linear mipmapped textures")
                }
            }
            let image = try doc.images.item(texture.source, "image")
            guard ["image/png", "image/jpeg"].contains(image.mimeType) else {
                throw RenderError("Expected embedded JPEG or PNG textures")
            }
            let view = try doc.bufferViews.item(image.bufferView, "image buffer view")
            let encoded = bytes.subdata(in: try span(view))
            return try loader.newTexture(data: encoded, options: [
                .SRGB: i == 0, .generateMipmaps: true, .origin: MTKTextureLoader.Origin.topLeft
            ])
        }
    }
}

extension SIMD4 where Scalar == Float {
    var xyz: V3 { V3(x, y, z) }
}

struct Uniforms {
    var rotation: simd_float4x4
    var framing, treatment: V4
}

func orbit(frame: Int) -> simd_float4x4 {
    let phase = 2 * Float.pi * Float(frame) / 300
    let radians = Float.pi / 180
    let dial = 25 * radians
    let yaw = 22 * radians * sin(phase)
    let roll = 12 * radians * cos(phase)
    let q = simd_quatf(angle: dial, axis: V3(0,0,1)) * simd_quatf(angle: yaw, axis: V3(0,1,0)) * simd_quatf(angle: roll, axis: V3(1,0,0))
    var transform = simd_float4x4(q)
    transform.columns.3 += V4(0.047 * cos(phase), 0.029 * sin(phase), 0, 0)
    return transform
}

func run() throws {
    let args = CommandLine.arguments
    guard args.count == 3 else { throw RenderError("Usage: MetalRenderer MODEL.glb SHADER.metal") }
    let width = 1056, height = 704
    let aspect = Float(width) / Float(height)
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { throw RenderError("Metal unavailable") }
    let model = try Model(url: URL(fileURLWithPath: args[1]), device: device)
    let shader = args[2]
    let library = try device.makeLibrary(source: String(contentsOfFile: shader, encoding: .utf8), options: nil)
    let pipeline = MTLRenderPipelineDescriptor()
    pipeline.vertexFunction = library.makeFunction(name: "knifeVertex")
    pipeline.fragmentFunction = library.makeFunction(name: "knifeFragment")
    pipeline.colorAttachments[0].pixelFormat = .bgra8Unorm_srgb
    pipeline.depthAttachmentPixelFormat = .depth32Float
    pipeline.rasterSampleCount = 4
    let attachment = pipeline.colorAttachments[0]!
    attachment.isBlendingEnabled = model.alphaBlend
    attachment.sourceRGBBlendFactor = .sourceAlpha
    attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
    attachment.sourceAlphaBlendFactor = .one
    attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
    let state = try device.makeRenderPipelineState(descriptor: pipeline)
    pipeline.vertexFunction = library.makeFunction(name: "backdropVertex")
    pipeline.fragmentFunction = library.makeFunction(name: "backdropFragment")
    attachment.isBlendingEnabled = false
    let backdrop = try device.makeRenderPipelineState(descriptor: pipeline)
    let depth = MTLDepthStencilDescriptor()
    depth.isDepthWriteEnabled = true
    depth.depthCompareFunction = .less
    let depthState = device.makeDepthStencilState(descriptor: depth)
    depth.isDepthWriteEnabled = false
    let translucentDepth = device.makeDepthStencilState(descriptor: depth)
    func target(format: MTLPixelFormat, samples: Int) -> MTLTexture {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: width, height: height, mipmapped: false)
        descriptor.textureType = samples > 1 ? .type2DMultisample : .type2D
        descriptor.sampleCount = samples
        descriptor.storageMode = samples > 1 ? .private : .shared
        descriptor.usage = .renderTarget
        return device.makeTexture(descriptor: descriptor)!
    }
    let output = target(format: .bgra8Unorm_srgb, samples: 1)
    let pass = MTLRenderPassDescriptor()
    let color = pass.colorAttachments[0]!
    color.texture = target(format: .bgra8Unorm_srgb, samples: 4)
    color.resolveTexture = output
    color.loadAction = .clear
    color.storeAction = .multisampleResolve
    color.clearColor = MTLClearColorMake(1, 1, 1, 1)
    pass.depthAttachment.texture = target(format: .depth32Float, samples: 4)
    pass.depthAttachment.loadAction = .clear
    pass.depthAttachment.storeAction = .dontCare
    pass.depthAttachment.clearDepth = 1
    let vertexBuffer = device.makeBuffer(bytes: model.vertices, length: model.vertices.count * MemoryLayout<Vertex>.stride)
    let indexBuffer = device.makeBuffer(bytes: model.indices, length: model.indices.count * MemoryLayout<UInt32>.stride)!
    var low = V3(repeating: .infinity), high = V3(repeating: -.infinity)
    var maxViewportHeight: Float = 0
    for f in 0..<300 {
        var frameLow = V3(repeating: .infinity), frameHigh = V3(repeating: -.infinity)
        let transform = orbit(frame: f)
        for vertex in model.vertices {
            let point = (transform * vertex.position).xyz
            frameLow = simd_min(frameLow, point)
            frameHigh = simd_max(frameHigh, point)
        }
        low = simd_min(low, frameLow)
        high = simd_max(high, frameHigh)
        maxViewportHeight = max(maxViewportHeight, (frameHigh.x - frameLow.x) / aspect, frameHigh.y - frameLow.y)
    }
    let center = (high + low) / 2
    let scaleY = 1.66 / maxViewportHeight
    let fit = V4(center.x, center.y, scaleY / aspect, scaleY)
    let region = MTLRegionMake2D(0, 0, width, height)
    var pixels = Data(count: width * height * 4)
    for frame in 0..<300 {
        try autoreleasepool {
            // Keep the shader selector fixed at 1; specializing it changes Metal's rounding.
            var params = Uniforms(rotation: orbit(frame: frame), framing: fit,
                                  treatment: V4(1, 0, model.alphaBlend ? 1 : 0, 0))
            let commands = queue.makeCommandBuffer()!
            let encoder = commands.makeRenderCommandEncoder(descriptor: pass)!
            encoder.setRenderPipelineState(backdrop)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            encoder.setRenderPipelineState(state)
            encoder.setDepthStencilState(depthState)
            encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)
            encoder.setVertexBytes(&params, length: MemoryLayout<Uniforms>.stride, index: 1)
            encoder.setFragmentBytes(&params, length: MemoryLayout<Uniforms>.stride, index: 1)
            for (i, map) in model.textures.enumerated() { encoder.setFragmentTexture(map, index: i) }
            func draw() {
                encoder.drawIndexedPrimitives(type: .triangle, indexCount: model.indices.count, indexType: .uint32, indexBuffer: indexBuffer, indexBufferOffset: 0)
            }
            encoder.setFrontFacing(.counterClockwise)
            if !model.doubleSided { encoder.setCullMode(.back) }
            draw()
            if model.alphaBlend {
                params.treatment.w = 1
                encoder.setFragmentBytes(&params, length: MemoryLayout<Uniforms>.stride, index: 1)
                encoder.setDepthStencilState(translucentDepth)
                if model.doubleSided {
                    encoder.setCullMode(.front)
                    draw()
                }
                encoder.setCullMode(.back)
                draw()
            }
            encoder.endEncoding()
            commands.commit()
            commands.waitUntilCompleted()
            if let failure = commands.error { throw failure }
            pixels.withUnsafeMutableBytes { output.getBytes($0.baseAddress!, bytesPerRow: width * 4, from: region, mipmapLevel: 0) }
            try FileHandle.standardOutput.write(contentsOf: pixels)
        }
    }
}

do { try run() } catch {
    FileHandle.standardError.write(Data(("MetalRenderer: " + error.localizedDescription + "\n").utf8))
    exit(1)
}
