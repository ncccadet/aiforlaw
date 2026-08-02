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
    background: 'radial-gradient(ellipse at 50% 20%, #1c180e 0%, #08080c 75%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: "'Cormorant Garamond', 'Lora', Georgia, serif",
    padding: '1.5rem',
    boxSizing: 'border-box'
  },
  card: {
    width: '100%',
    maxWidth: '430px',
    background: 'rgba(14, 15, 22, 0.88)',
    backdropFilter: 'blur(24px)',
    WebkitBackdropFilter: 'blur(24px)',
    border: '1px solid rgba(212, 175, 55, 0.38)',
    borderRadius: '20px',
    padding: '2.75rem 2.5rem',
    boxShadow: '0 20px 50px rgba(0, 0, 0, 0.85), 0 0 30px rgba(212, 175, 55, 0.15)',
    display: 'flex',
    flexDirection: 'column'
  },
  title: {
    color: '#f5d77f',
    background: 'linear-gradient(135deg, #FFF1C5 0%, #D4AF37 50%, #AA771C 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    fontSize: '2.4rem',
    fontWeight: '700',
    margin: 0,
    textAlign: 'center',
    letterSpacing: '0.05em',
    filter: 'drop-shadow(0 2px 12px rgba(212, 175, 55, 0.3))'
  },
  subtitle: {
    color: '#b8af94',
    fontSize: '0.95rem',
    textAlign: 'center',
    marginTop: '0.5rem',
    marginBottom: '2rem',
    letterSpacing: '0.02em'
  },
  label: {
    color: '#f5d77f',
    fontSize: '0.85rem',
    marginBottom: '0.45rem',
    marginTop: '1.1rem',
    letterSpacing: '0.05em',
    textTransform: 'uppercase'
  },
  input: {
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(212, 175, 55, 0.28)',
    borderRadius: '10px',
    padding: '0.8rem 1.1rem',
    color: '#f8f6f0',
    fontSize: '1rem',
    fontFamily: 'inherit',
    outline: 'none',
    boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease'
  },
  button: {
    marginTop: '2.25rem',
    padding: '0.9rem',
    borderRadius: '12px',
    border: 'none',
    background: 'linear-gradient(135deg, #FFF1C5 0%, #D4AF37 50%, #AA771C 100%)',
    color: '#07070a',
    fontSize: '1.05rem',
    fontWeight: '700',
    fontFamily: 'inherit',
    cursor: 'pointer',
    letterSpacing: '0.05em',
    boxShadow: '0 6px 24px rgba(212, 175, 55, 0.35)',
    transition: 'transform 0.15s ease, box-shadow 0.15s ease'
  },
  link: {
    marginTop: '1.35rem',
    textAlign: 'center',
    color: '#d4af37',
    fontSize: '0.9rem',
    textDecoration: 'none',
    opacity: 0.9,
    transition: 'opacity 0.2s ease'
  },
  error: {
    background: 'rgba(212, 70, 70, 0.15)',
    border: '1px solid rgba(212, 70, 70, 0.45)',
    color: '#ffa8a8',
    borderRadius: '10px',
    padding: '0.75rem 1.1rem',
    fontSize: '0.85rem',
    marginBottom: '0.5rem'
  }
};