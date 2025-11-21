interface ProgressBarProps {
  minted: number;
  total: number;
}

export function ProgressBar({ minted, total }: ProgressBarProps) {
  const pct = Math.min(100, Math.round((minted / total) * 100));
  return (
    <div className="progress">
      <div className="progress__meta">
        <span>{minted} minted</span>
        <span>{total - minted} left</span>
      </div>
      <div className="progress__bar">
        <div className="progress__fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress__pct">{pct}% done</div>
    </div>
  );
}
