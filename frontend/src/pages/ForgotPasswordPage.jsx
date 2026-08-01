/**
 * ForgotPasswordPage.jsx
 */
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { forgotPassword } from '../services/auth.service';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await forgotPassword(email);
      setSent(true);
    } catch (err) {
      if (err.response?.status === 429) {
        setError(err.response?.data?.error || 'Too many attempts. Please try again later.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Forgot Password</h1>
        <p style={styles.subtitle}>
          {sent
            ? 'If that email exists, an OTP has been sent.'
            : "Enter your email and we'll send you a one-time code."}
        </p>

        {error && <div style={styles.error}>{error}</div>}

        {!sent ? (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column' }}>
            <label style={styles.label}>Email</label>
            <input
              style={styles.input}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
            <button style={styles.button} type="submit" disabled={loading}>
              {loading ? 'Sending...' : 'Send OTP'}
            </button>
          </form>
        ) : (
          <button
            style={styles.button}
            onClick={() => navigate('/reset-password', { state: { email } })}
          >
            Enter OTP
          </button>
        )}

        <Link to="/login" style={styles.link}>Back to sign in</Link>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh', width: '100%', background: '#0a0a0a',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: "'Calisto MT', Georgia, serif", padding: '1.5rem', boxSizing: 'border-box'
  },
  card: {
    width: '100%', maxWidth: '400px',
    background: 'rgba(255, 255, 255, 0.06)',
    backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '16px',
    padding: '2.5rem 2rem', boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
    display: 'flex', flexDirection: 'column'
  },
  title: { color: '#fff', fontSize: '1.75rem', margin: 0, textAlign: 'center' },
  subtitle: { color: 'rgba(255,255,255,0.6)', fontSize: '0.95rem', textAlign: 'center', marginTop: '0.5rem', marginBottom: '2rem' },
  label: { color: 'rgba(255,255,255,0.8)', fontSize: '0.85rem', marginBottom: '0.4rem' },
  input: {
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px', padding: '0.75rem 1rem', color: '#fff', fontSize: '1rem',
    fontFamily: 'inherit', outline: 'none'
  },
  button: {
    marginTop: '2rem', padding: '0.85rem', borderRadius: '10px', border: 'none',
    background: 'rgba(255,255,255,0.9)', color: '#0a0a0a', fontSize: '1rem',
    fontWeight: 'bold', fontFamily: 'inherit', cursor: 'pointer'
  },
  link: { marginTop: '1.25rem', textAlign: 'center', color: 'rgba(255,255,255,0.6)', fontSize: '0.9rem', textDecoration: 'none' },
  error: {
    background: 'rgba(255, 80, 80, 0.15)', border: '1px solid rgba(255, 80, 80, 0.4)',
    color: '#ff9d9d', borderRadius: '8px', padding: '0.7rem 1rem', fontSize: '0.85rem', marginBottom: '0.5rem'
  }
};