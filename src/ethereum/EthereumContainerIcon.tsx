export function EthereumContainerIcon({ kind }: { kind: 'crate' | 'warehouse' }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    {kind === 'crate' ? <g stroke="#68513b" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M24 5L41 14L24 23L7 14Z" fill="#e8c77f" />
      <path d="M7 14L24 23V43L7 34Z" fill="#c59454" />
      <path d="M24 23L41 14V34L24 43Z" fill="#d9b16b" />
      <path d="M15 10L32 19V39M16 39V19L33 10M7 24L24 33L41 24" fill="none" strokeWidth="1.4" />
    </g> : <g stroke="#52664f" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M6 19L24 7L42 19V42H6Z" fill="#c6d1bb" />
      <path d="M3 20L24 6L45 20" fill="none" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M13 23H35V42H13Z" fill="#91a787" />
      <path d="M13 29H35M13 35H35" fill="none" strokeWidth="1.4" />
    </g>}
  </svg>;
}
