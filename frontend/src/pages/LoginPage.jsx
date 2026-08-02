/**
 * LoginPage.jsx
 */
import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { login } from '../services/auth.service';

export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const reason = sessionStorage.getItem('authRedirectReason');
    if (reason) {
      setError(reason);
      sessionStorage.removeItem('authRedirectReason');
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        setError(err.response?.data?.error || 'Too many attempts. Please try again later.');
      } else if (status === 401) {
        setError(err.response?.data?.error || 'Invalid email or password');
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
        <h1 style={styles.title}>Law AI</h1>
        <p style={styles.subtitle}>Sign in to continue</p>

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

        <label style={styles.label}>Password</label>
        <input
          style={styles.input}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />

        <button style={styles.button} type="submit" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>

        <Link to="/forgot-password" style={styles.link}>Forgot password?</Link>
      </form>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    width: '100%',
    background: 'radial-gradient(circle at 50% 30%, #17150e 0%, #08080a 70%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: "'Cormorant Garamond', 'Calisto MT', Georgia, serif",
    padding: '1.5rem',
    boxSizing: 'border-box'
  },
  card: {
    width: '100%',
    maxWidth: '420px',
    background: 'rgba(16, 16, 20, 0.85)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid rgba(212, 175, 55, 0.3)',
    borderRadius: '16px',
    padding: '2.5rem 2.25rem',
    boxShadow: '0 12px 40px rgba(0, 0, 0, 0.7), 0 0 20px rgba(212, 175, 55, 0.08)',
    display: 'flex',
    flexDirection: 'column'
  },
  title: {
    color: '#f5d77f',
    fontSize: '2.1rem',
    fontWeight: '700',
    margin: 0,
    textAlign: 'center',
    letterSpacing: '0.04em',
    textShadow: '0 2px 10px rgba(212, 175, 55, 0.2)'
  },
  subtitle: {
    color: '#c5bc9c',
    fontSize: '0.95rem',
    textAlign: 'center',
    marginTop: '0.5rem',
    marginBottom: '2rem'
  },
  label: {
    color: '#e5c158',
    fontSize: '0.85rem',
    marginBottom: '0.4rem',
    marginTop: '1rem',
    letterSpacing: '0.03em'
  },
  input: {
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(212, 175, 55, 0.25)',
    borderRadius: '8px',
    padding: '0.75rem 1rem',
    color: '#f8f6f0',
    fontSize: '1rem',
    fontFamily: 'inherit',
    outline: 'none',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease'
  },
  button: {
    marginTop: '2rem',
    padding: '0.85rem',
    borderRadius: '10px',
    border: 'none',
    background: 'linear-gradient(135deg, #f5d77f 0%, #d4af37 50%, #b8860b 100%)',
    color: '#08080a',
    fontSize: '1.05rem',
    fontWeight: '700',
    fontFamily: 'inherit',
    cursor: 'pointer',
    letterSpacing: '0.04em',
    boxShadow: '0 4px 20px rgba(212, 175, 55, 0.3)',
    transition: 'transform 0.15s ease, box-shadow 0.15s ease'
  },
  link: {
    marginTop: '1.25rem',
    textAlign: 'center',
    color: '#d4af37',
    fontSize: '0.9rem',
    textDecoration: 'none',
    opacity: 0.85
  },
  error: {
    background: 'rgba(212, 70, 70, 0.15)',
    border: '1px solid rgba(212, 70, 70, 0.4)',
    color: '#ffa8a8',
    borderRadius: '8px',
    padding: '0.7rem 1rem',
    fontSize: '0.85rem',
    marginBottom: '0.5rem'
  }
};