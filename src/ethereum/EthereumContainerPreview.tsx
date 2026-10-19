export function EthereumContainerPreview({ kind }: { kind: 'crate' | 'warehouse' }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720"
    role="img" aria-label={kind === 'crate' ? '111K crate' : '111K warehouse'} focusable="false">
    <g fill="#191d29" fontFamily="Arial,Helvetica,sans-serif">
      {kind === 'crate' ? <g transform="translate(360 360) scale(1.3) translate(-360 -453)">
        <g stroke="#68513b" strokeWidth="5" strokeLinejoin="round">
          <path d="M360 260L540 350L360 440L180 350Z" fill="#e8c77f" />
          <path d="M180 350L360 440V646L180 553Z" fill="#c59454" />
          <path d="M360 440L540 350V553L360 646Z" fill="#d9b16b" />
          <path d="M264 307L444 398V600M276 600V398L456 307" fill="none" />
          <path d="M180 415L360 507L540 415M180 491L360 583L540 491" fill="none" strokeWidth="3" />
          <path d="M405 463L497 417V492L405 538Z" fill="#fff7e6" strokeWidth="2" />
        </g>
        <g transform="matrix(1 -.5 0 1 451 478)">
          <text x="0" y="8" textAnchor="middle" fontSize="22" fontWeight="900" letterSpacing="-1" fill="#68513b">?</text>
        </g>
      </g> : <g transform="translate(360 360) scale(1.28) translate(-360 -441)">
        <g stroke="#52664f" strokeWidth="5" strokeLinejoin="round">
          <path d="M150 374L360 246L570 374V644H150Z" fill="#c6d1bb" />
          <path d="M132 382L360 240L588 382" fill="none" strokeWidth="9" />
          <path d="M203 409H517V644H203Z" fill="#91a787" />
          <path d="M203 452H517M203 493H517M203 534H517M203 575H517M203 616H517" strokeWidth="3" />
          <path d="M258 291H462V355H258Z" fill="#f6f2e6" />
          <rect x="302" y="533" width="116" height="111" fill="#e1e7d8" />
          <path d="M360 533V644M302 588H418" strokeWidth="3" />
        </g>
        <text x="360" y="335" textAnchor="middle" fontSize="34" fontWeight="900" letterSpacing="-1" fill="#52664f">?</text>
      </g>}
    </g>
  </svg>;
}
