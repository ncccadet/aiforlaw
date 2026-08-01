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
        <h1 style={styles.title}>Voxera For Law</h1>
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
    background: '#0a0a0a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: "'Calisto MT', Georgia, serif",
    padding: '1.5rem',
    boxSizing: 'border-box'
  },
  card: {
    width: '100%',
    maxWidth: '400px',
    background: 'rgba(255, 255, 255, 0.06)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: '16px',
    padding: '2.5rem 2rem',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
    display: 'flex',
    flexDirection: 'column'
  },
  title: {
    color: '#fff',
    fontSize: '1.75rem',
    margin: 0,
    textAlign: 'center'
  },
  subtitle: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: '0.95rem',
    textAlign: 'center',
    marginTop: '0.5rem',
    marginBottom: '2rem'
  },
  label: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: '0.85rem',
    marginBottom: '0.4rem',
    marginTop: '1rem'
  },
  input: {
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px',
    padding: '0.75rem 1rem',
    color: '#fff',
    fontSize: '1rem',
    fontFamily: 'inherit',
    outline: 'none',
    transition: 'border-color 0.2s ease, background 0.2s ease'
  },
  button: {
    marginTop: '2rem',
    padding: '0.85rem',
    borderRadius: '10px',
    border: 'none',
    background: 'rgba(255,255,255,0.9)',
    color: '#0a0a0a',
    fontSize: '1rem',
    fontWeight: 'bold',
    fontFamily: 'inherit',
    cursor: 'pointer',
    transition: 'transform 0.15s ease, opacity 0.15s ease'
  },
  link: {
    marginTop: '1.25rem',
    textAlign: 'center',
    color: 'rgba(255,255,255,0.6)',
    fontSize: '0.9rem',
    textDecoration: 'none'
  },
  error: {
    background: 'rgba(255, 80, 80, 0.15)',
    border: '1px solid rgba(255, 80, 80, 0.4)',
    color: '#ff9d9d',
    borderRadius: '8px',
    padding: '0.7rem 1rem',
    fontSize: '0.85rem',
    marginBottom: '0.5rem'
  }
};