// Raw Node source execution resolves explicit `.js` specifiers literally, while
// the Functions TypeScript build resolves this specifier to boxMinterProtocol.ts
// and emits that implementation at this pathname.
export * from './boxMinterProtocol.ts';
