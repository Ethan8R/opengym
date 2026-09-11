import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { loginAccount, registerAccount, api } from '../lib/api.js'
import { hasData } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { DEMO, REPO } from '../lib/demo.js'
import { useState, useRef, useEffect } from 'react'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

// Enter should submit from any field in these sheets — they are short forms, and reaching for the
// button after typing a password is the kind of friction people notice every single time.
const onEnter = go => e => { if (e.key === 'Enter') { e.preventDefault(); go() } }

function SignInSheet({ close }) {
  const { setUser, pullState } = useStore()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  const go = async () => {
    if (busy) return
    if (!email.trim() || !password) { useUI.getState().toast(t('Enter your email and password')); return }
    setBusy(true)
    try {
      const u = await loginAccount({ email: email.trim(), password })
      setUser(u); close()
      await pullState()
      useUI.getState().toast(t('Welcome back, {0}', u.name))
    } catch (e) { useUI.getState().toast(e.message || t('Sign-in failed')) }
    finally { setBusy(false) }
  }
  return <>
    <h3>{t('Sign in')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Your plan, workouts and weigh-ins sync to this profile on every device you sign in on.')}</div>
    <input ref={ref} className="input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none"
      placeholder={t('Email')} value={email} onChange={e => setEmail(e.target.value)} onKeyDown={onEnter(go)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" autoComplete="current-password"
      placeholder={t('Password')} value={password} onChange={e => setPassword(e.target.value)} onKeyDown={onEnter(go)} />
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={go} disabled={busy}>{busy ? t('Signing in…') : t('Sign in')}</Button>
  </>
}

function RegisterSheet({ close }) {
  const { setUser, pushState, pullState } = useStore()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [inviteOnly, setInviteOnly] = useState(false)
  const [minPassword, setMinPassword] = useState(8)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  useEffect(() => {
    api('/api/config').then(c => { setInviteOnly(!!c.invite_only); if (c.min_password) setMinPassword(c.min_password) }).catch(() => {})
  }, [])
  const go = async () => {
    if (busy) return
    const n = name.trim()
    if (!n) { useUI.getState().toast(t('Enter a name')); return }
    if (!email.trim()) { useUI.getState().toast(t('Enter your email')); return }
    if (password.length < minPassword) { useUI.getState().toast(t('Password must be at least {0} characters', minPassword)); return }
    if (inviteOnly && !code.trim()) { useUI.getState().toast(t('An invite code is required')); return }
    setBusy(true)
    try {
      const u = await registerAccount({ name: n, email: email.trim(), password, code: code.trim() })
      setUser(u); close()
      if (hasData(useStore.getState().S)) { await pushState(); useUI.getState().toast(t('Profile created — data from this device moved into it')) }
      else { await pullState(); useUI.getState().toast(t('Welcome, {0}', u.name)) }
    } catch (e) { useUI.getState().toast(e.message || t('Registration failed')) }
    finally { setBusy(false) }
  }
  return <>
    <h3>{t('Create your profile')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name, then an email and password to sign in with on your other devices.')}</div>
    <input ref={ref} className="input" placeholder={t('Your name')} maxLength={40} value={name}
      onChange={e => setName(e.target.value)} onKeyDown={onEnter(go)} />
    <div style={{ height: 10 }} />
    <input className="input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none"
      placeholder={t('Email')} value={email} onChange={e => setEmail(e.target.value)} onKeyDown={onEnter(go)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" autoComplete="new-password"
      placeholder={t('Password')} value={password} onChange={e => setPassword(e.target.value)} onKeyDown={onEnter(go)} />
    <div className="dim small" style={{ marginTop: 6 }}>{t('At least {0} characters.', minPassword)}</div>
    {inviteOnly && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
        onChange={e => setCode(e.target.value.toUpperCase())} onKeyDown={onEnter(go)}
        style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
      <div className="dim small" style={{ marginTop: 6 }}>{t('This app is invite-only — enter the code you were given.')}</div>
    </>}
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={go} disabled={busy}>{busy ? t('Creating…') : t('Create profile')}</Button>
  </>
}

export default function Login() {
  const { setGuest } = useStore()
  const head = <>
    <div style={{ fontSize: 54, display: 'flex', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="dumbbell" /></div>
    <h1 style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-.028em', margin: '10px 0 4px' }}>openGym</h1>
  </>
  const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }

  // Demo build: no backend to sign in against — the only way in is the local guest profile.
  if (DEMO) return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 30 }}>{t('Live demo — everything stays in this browser.')}</div>
      <Button variant="primary" icon="sparkles" onClick={() => setGuest(true)}>{t('Start the demo')}</Button>
      <div className="card small muted" style={{ textAlign: 'left', marginTop: 16 }}>
        {t('This demo runs entirely in your browser on example data — nothing is sent anywhere. Sign-in and sync across your devices come with the openGym server, which you get by self-hosting it.')}
      </div>
      <div className="dim small" style={{ marginTop: 22, lineHeight: 1.6 }}>
        <a href={REPO} target="_blank" rel="noopener">{t('Self-host it in a minute →')}</a>
      </div>
    </div>
  )

  return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 34 }}>{t('Your workouts. Your weights. Your profile.')}</div>
      <Button variant="primary" icon="person" onClick={() => useUI.getState().openSheet(close => <SignInSheet close={close} />)}>{t('Sign in')}</Button>
      <div style={{ height: 10 }} />
      <Button icon="sparkles" onClick={() => useUI.getState().openSheet(close => <RegisterSheet close={close} />)}>{t('Create new profile')}</Button>
      <div style={{ height: 10 }} />
      <Button variant="ghost" className="dim" onClick={() => setGuest(true)}>{t('Continue without account')}</Button>
      <div className="dim small" style={{ marginTop: 26, lineHeight: 1.5 }}>{t('Each profile keeps its own plan, workouts & body weight.')}</div>
    </div>
  )
}
