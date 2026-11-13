import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { agentPrivacy, profileLockRequest, useProfileLock } from './profile-lock.ts'

/** A 6-digit PIN field (digits only, hidden like a phone lock screen). */
export function PinInput({ id, value, onChange, length = 6, autoFocus = false, label }: { id: string; value: string; onChange: (value: string) => void; length?: number; autoFocus?: boolean; label: string }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (autoFocus) input.current?.focus() }, [autoFocus])
  return <label className="pin-field" htmlFor={id}>
    <span className="field-label">{label}</span>
    <input ref={input} id={id} className="pin-input" type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={length} value={value} onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, length))}/>
    <span className="pin-dots" aria-hidden="true">{Array.from({ length }, (_, index) => <i key={index} className={index < value.length ? 'filled' : ''}/>)}</span>
  </label>
}

/** Asks for the PIN to open one locked agent in this browser. */
export function ProfileUnlock({ agent, minutes = 15, compact = false }: { agent: string; minutes?: number; compact?: boolean }) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pin.length !== 6) { setError('Enter the 6-digit PIN.'); return }
    setBusy(true)
    setError(undefined)
    const result = await profileLockRequest('unlock', { agent, pin })
    setBusy(false)
    if (!result.ok) { setError(result.message); setPin('') }
  }
  return <form className={`profile-unlock${compact ? ' compact' : ''}`} onSubmit={submit} aria-label={`Unlock ${agent}`}>
    <p className="profile-unlock-icon" aria-hidden="true">🔒</p>
    <h3>{agent} is locked</h3>
    <p className="muted">Its memory, files, tasks and activity are private. Enter the PIN to open them in this browser for {minutes} minutes.</p>
    <PinInput id={`pin-${agent}`} value={pin} onChange={setPin} autoFocus label="PIN"/>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button type="submit" className="primary-button" disabled={busy || pin.length !== 6}>{busy ? 'Checking…' : 'Unlock'}</button>
  </form>
}

/** Bar shown above an unlocked agent's private data, to lock it again. */
export function RelockBar({ agent, minutes }: { agent: string; minutes: number }) {
  return <div className="relock-bar"><span>🔓 {agent} is unlocked in this browser (up to {minutes} min).</span><button type="button" className="refresh-button" onClick={() => void profileLockRequest('lock', { agent })}>🔒 LOCK AGAIN</button></div>
}

/**
 * Shows `children` only when the agent is not locked (or unlocked with the PIN); otherwise the
 * PIN prompt. The server enforces the same rule, so this is about what to show, not security.
 */
export function PrivateGate({ agent, children, compact = false }: { agent: string | undefined; children: ReactNode; compact?: boolean }) {
  const status = useProfileLock()
  const privacy = agentPrivacy(status, agent)
  if (privacy === 'locked' && agent) return <ProfileUnlock agent={agent} minutes={status?.unlockMinutes} compact={compact}/>
  return <>
    {privacy === 'unlocked' && agent && <RelockBar agent={agent} minutes={status?.unlockMinutes ?? 15}/>}
    <div key={privacy}>{children}</div>
  </>
}
