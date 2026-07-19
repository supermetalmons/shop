// Raw Node source execution resolves explicit `.js` specifiers literally, while
// the Functions TypeScript build resolves this specifier to byteCodec.ts and
// emits that implementation at this pathname.
export * from './byteCodec.ts';
