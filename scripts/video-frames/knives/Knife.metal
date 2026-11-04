#include <metal_stdlib>
using namespace metal;

struct Backdrop {
    float4 position [[position]];
    float2 uv;
};

vertex Backdrop backdropVertex(uint index [[vertex_id]]) {
    constexpr float2 triangle[] = {float2(-1, -1), float2(3, -1), float2(-1, 3)};
    float2 xy = triangle[index];
    return {float4(xy, 0.99, 1), (xy * float2(1, -1) + 1) * 0.5};
}

fragment float4 backdropFragment(Backdrop s [[stage_in]]) {
    float2 radius = (s.uv - float2(0.48, 0.44)) / float2(0.425, 0.575);
    float grey = 29 + 112 * exp(-1.25 * dot(radius, radius));
    float dither = fract(52.9829189 * fract(dot(floor(s.position.xy), float2(0.06711056, 0.00583715)))) - 0.5;
    float linear = pow((grey + dither + 14.025) / 269.025, 2.4f);
    return float4(float3(linear), 1);
}

struct Vertex {
    float4 position;
    float4 normal;
    float4 tangent;
    float4 texcoord;
};

struct Uniforms {
    float4x4 rotation;
    float4 framing;
    float4 treatment;
};

struct Surface {
    float4 position [[position]];
    float3 location;
    float3 normal;
    float4 tangent;
    float2 uv;
    float axis;
};

vertex Surface knifeVertex(uint index [[vertex_id]], device const Vertex *mesh [[buffer(0)]],
                           constant Uniforms &u [[buffer(1)]]) {
    Vertex v = mesh[index];
    float3 p = (u.rotation * v.position).xyz;
    Surface s;
    s.location = p;
    s.position = float4((p.xy - u.framing.xy) * u.framing.zw, 0.5 - p.z * 0.22, 1);
    s.normal = (u.rotation * float4(v.normal.xyz, 0)).xyz;
    s.tangent = float4((u.rotation * float4(v.tangent.xyz, 0)).xyz, v.tangent.w);
    s.uv = v.texcoord.xy;
    s.axis = v.position.x;
    return s;
}

struct LightSum {
    float3 diffuse;
    float3 reflection;
};

float gaussianCDF(float x) {
    return 0.5 + 0.5 * tanh(clamp(0.85f * x, -8.0f, 8.0f));
}

float blurredInterval(float x, float width, float blur) {
    return gaussianCDF((x + width) / blur) - gaussianCDF((x - width) / blur);
}

void softbox(thread LightSum &light, float3 p, float3 n, float3 reflection, float roughness,
             float3 center, float3 longAxis, float2 size, float3 radiance) {
    float3 forward = normalize(center);
    float3 side = normalize(cross(forward, longAxis));
    float3 up = cross(side, forward);
    float3 toBox = center - p;
    float3 incident = normalize(toBox);
    float solidAngle = min(1.5f, size.x * size.y * max(dot(incident, forward), 0.0f) / dot(toBox, toBox));
    light.diffuse += radiance * (solidAngle / M_PI_F) * max(0.0f, dot(n, incident));
    float cosRay = dot(reflection, forward);
    float distance = dot(toBox, forward) / max(0.06f, cosRay);
    float3 hit = p + reflection * distance - center;
    float blur = 0.025 + (roughness * roughness) * max(0.1f, distance) * 1.6;
    float visible = blurredInterval(dot(hit, up), size.x * 0.5, blur) *
                    blurredInterval(dot(hit, side), size.y * 0.5, blur);
    light.reflection += radiance * visible * smoothstep(0.0f, 0.17f, cosRay);
}

fragment float4 knifeFragment(Surface s [[stage_in]], constant Uniforms &u [[buffer(1)]],
                              texture2d<float> colorMap [[texture(0)]],
                              texture2d<float> normalMap [[texture(1)]],
                              texture2d<float> pbrMap [[texture(2)]]) {
    constexpr sampler lookup(coord::normalized, address::repeat, filter::linear, mip_filter::linear, max_anisotropy(8));
    float4 base = colorMap.sample(lookup, s.uv);
    float alpha = u.treatment.z > 0.5 ? base.a : 1.0;
    if (u.treatment.w < 0.5 ? alpha < 0.998 : (alpha >= 0.998 || alpha < 0.001)) discard_fragment();
    float3 baked = normalMap.sample(lookup, s.uv).xyz * 2.0 - 1.0;
    float3 n = normalize(s.normal);
    float3 t = normalize(s.tangent.xyz - n * dot(n, s.tangent.xyz));
    float3 b = cross(n, t) * s.tangent.w;
    n = normalize(t * baked.x + b * baked.y + n * baked.z);
    float3 view = float3(0, 0, 1);
    if (dot(s.normal, view) < 0) n = -n;
    float3 r = reflect(-view, n);
    float4 pbr = pbrMap.sample(lookup, s.uv);
    float rough = clamp(pbr.g, 0.045f, 1.0f);
    float metal = pbr.b;
    int look = int(u.treatment.x);
    LightSum light;
    light.diffuse = float3(0.42 + 0.18 * (0.5 + 0.5 * n.y));
    float bounce = smoothstep(-0.2f, 0.92f, dot(r, normalize(float3(-0.45, 0.82, 0.18))));
    light.reflection = float3(0.17 + 0.46 * bounce);
    float3 p = s.location;
    if (look == 0) {
        softbox(light, p, n, r, rough, float3(-0.7, 0.68, 1.72), float3(1, 0.3, 0), float2(3.1, 1.9), float3(2.75, 2.18, 1.63));
        softbox(light, p, n, r, rough, float3(0.92, -1.0, 0.65), float3(1, 0.25, 0), float2(3.5, 0.84), float3(1.25, 2.25, 3.65));
    } else {
        light.diffuse *= 0.76;
        light.reflection *= 0.7;
        softbox(light, p, n, r, rough, float3(-1.3, -0.3, 0.75), float3(0.18, 1, 0), float2(3.7, 0.78), float3(3.3));
        softbox(light, p, n, r, rough, float3(1.15, 0.36, 1.05), float3(0.28, 1, 0), float2(3.5, 0.62), float3(3.8));
        softbox(light, p, n, r, rough, float3(-0.65, -0.18, 1.9), float3(1, 0.28, 0), float2(2.5, 1.15), float3(0.82));
        softbox(light, p, n, r, rough, float3(-0.62, 0.55, 1.48), float3(0.32, 1, 0), float2(2.7, 0.70), float3(1.9));
    }
    light.diffuse *= 1.82;
    if (u.treatment.z > 0.5) {
        // A blade-length bounce card or black cutter keeps the translucent M9 legible.
        float cutter = smoothstep(-0.52f, -0.17f, s.axis);
        if (look != 0) {
            light.diffuse += 0.85 * cutter;
        } else {
            light.diffuse *= mix(1.0f, 0.069f, cutter);
            light.reflection *= mix(1.0f, 0.55f, cutter);
        }
    }
    float ndv = saturate(dot(n, view));
    float grazing = pow(1 - ndv, 5.0f);
    float3 f0 = mix(float3(0.04), base.rgb, metal);
    float3 fresnel = mix(f0, max(float3(1 - rough), f0), grazing);
    float polarizer = mix(0.34f, 1.0f, max(metal, grazing));
    float3 rgb = base.rgb * (1 - metal) * (1 - fresnel) * light.diffuse + fresnel * light.reflection * polarizer;
    rgb *= exp2(-0.45f);
    float peak = max3(rgb.r, rgb.g, rgb.b);
    if (peak > 0.62) {
        float shoulder = 0.62 + 0.38 * (1 - exp((0.62 - peak) / 0.38));
        rgb *= shoulder / peak;
    }
    return float4(rgb, alpha);
}
