import { FormEvent, useState } from 'react';

interface ContactEmailProps {
  email: string;
  onChange: (value: string) => void;
  onSave: (value: string) => Promise<void> | void;
}

export function ContactEmail({ email, onChange, onSave }: ContactEmailProps) {
  const [saving, setSaving] = useState(false);
  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    setSaving(true);
    try {
      await onSave(email.trim());
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card" onSubmit={handleSubmit}>
      <div className="card__title">Contact email</div>
      <p className="muted small">Used for delivery updates across all saved addresses.</p>
      <label>
        <span className="muted">Email</span>
        <input
          required
          type="email"
          value={email}
          onChange={(e) => onChange(e.target.value)}
          placeholder="you@example.com"
        />
      </label>
      <button type="submit" disabled={!email || saving}>
        {saving ? 'Saving…' : 'Save email'}
      </button>
    </form>
  );
}
