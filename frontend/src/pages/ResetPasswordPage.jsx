/**
 * ResetPasswordPage.jsx
 */
import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { resetPassword } from '../services/auth.service';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState(location.state?.email || '');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await resetPassword(email, otp, newPassword);
      navigate('/login', { state: { message: 'Password changed. Please log in.' } });
    } catch (err) {
      if (err.response?.status === 429) {
        setError(err.response?.data?.error || 'Too many attempts. Please try again later.');
      } else if (err.response?.status === 400) {
        setError(err.response?.data?.error || 'Invalid or expired code');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.page}>
      <form style={styles.card} onSubmit={handleSubmit}>
        <h1 style={styles.title}>Reset Password</h1>
        <p style={styles.subtitle}>Enter the code sent to your email and choose a new password.</p>

        {error && <div style={styles.error}>{error}</div>}

        <label style={styles.label}>Email</label>
        <input
          style={styles.input}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />

        <label style={styles.label}>OTP Code</label>
        <input
          style={styles.input}
          type="text"
          inputMode="numeric"
          maxLength={6}
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          required
        />

        <label style={styles.label}>New Password</label>
        <input
          style={styles.input}
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          autoComplete="new-password"
        />

        <label style={styles.label}>Confirm New Password</label>
        <input
          style={styles.input}
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          autoComplete="new-password"
        />

        <button style={styles.button} type="submit" disabled={loading}>
          {loading ? 'Resetting...' : 'Reset Password'}
        </button>

        <Link to="/login" style={styles.link}>Back to sign in</Link>
      </form>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh', width: '100%',
    background: 'radial-gradient(circle at 50% 30%, #17150e 0%, #08080a 70%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: "'Cormorant Garamond', 'Calisto MT', Georgia, serif", padding: '1.5rem', boxSizing: 'border-box'
  },
  card: {
    width: '100%', maxWidth: '420px',
    background: 'rgba(16, 16, 20, 0.85)',
    backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid rgba(212, 175, 55, 0.3)', borderRadius: '16px',
    padding: '2.5rem 2.25rem', boxShadow: '0 12px 40px rgba(0, 0, 0, 0.7), 0 0 20px rgba(212, 175, 55, 0.08)',
    display: 'flex', flexDirection: 'column'
  },
  title: { color: '#f5d77f', fontSize: '2rem', fontWeight: '700', margin: 0, textAlign: 'center', letterSpacing: '0.04em' },
  subtitle: { color: '#c5bc9c', fontSize: '0.9rem', textAlign: 'center', marginTop: '0.5rem', marginBottom: '2rem' },
  label: { color: '#e5c158', fontSize: '0.85rem', marginBottom: '0.4rem', marginTop: '1rem' },
  input: {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(212, 175, 55, 0.25)',
    borderRadius: '8px', padding: '0.75rem 1rem', color: '#f8f6f0', fontSize: '1rem',
    fontFamily: 'inherit', outline: 'none'
  },
  button: {
    marginTop: '2rem', padding: '0.85rem', borderRadius: '10px', border: 'none',
    background: 'linear-gradient(135deg, #f5d77f 0%, #d4af37 50%, #b8860b 100%)', color: '#08080a', fontSize: '1rem',
    fontWeight: '700', fontFamily: 'inherit', cursor: 'pointer', boxShadow: '0 4px 20px rgba(212, 175, 55, 0.3)'
  },
  link: { marginTop: '1.25rem', textAlign: 'center', color: '#d4af37', fontSize: '0.9rem', textDecoration: 'none', opacity: 0.85 },
  error: {
    background: 'rgba(212, 70, 70, 0.15)', border: '1px solid rgba(212, 70, 70, 0.4)',
    color: '#ffa8a8', borderRadius: '8px', padding: '0.7rem 1rem', fontSize: '0.85rem', marginBottom: '0.5rem'
  }
};