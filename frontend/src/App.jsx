/**
 * App.jsx — Root React router
 *
 * All feature pages live inside <PrivateRoute>.
 * When you add a new feature (Step 6 of the 10-step checklist):
 *   1. Import the new Page component
 *   2. Add a <Route> inside the PrivateRoute wrapper
 *   3. Add the nav link to DashboardPage.jsx
 */
import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import LoginPage           from './pages/LoginPage';
import ForgotPasswordPage  from './pages/ForgotPasswordPage';
import ResetPasswordPage   from './pages/ResetPasswordPage';
import DashboardPage       from './pages/DashboardPage';
import ExamPrepPage        from './pages/ExamPrepPage';
import ResumeAnalyzerPage  from './pages/ResumeAnalyzerPage';
import JobBoardPage        from './pages/JobBoardPage';
import DraftingLabPage     from './pages/DraftingLabPage';
import CourtSimulationPage from './pages/CourtSimulationPage';
import AIInterviewerPage   from './pages/AIInterviewerPage';
import ResumeBuilderPage   from './pages/ResumeBuilderPage';
import { getMe } from './services/auth.service';

// Checks auth via /api/auth/me instead of reading document.cookie —
// accessToken is httpOnly, so it's never visible to JS. This is the
// only reliable way to know if the session is actually valid.
const PrivateRoute = ({ children }) => {
  const [authState, setAuthState] = useState('checking'); // 'checking' | 'authed' | 'unauthed'

  useEffect(() => {
    getMe()
      .then(() => setAuthState('authed'))
      .catch(() => setAuthState('unauthed'));
  }, []);

  if (authState === 'checking') return null; // or a loading spinner
  return authState === 'authed' ? children : <Navigate to="/login" replace />;
};

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/" element={<PrivateRoute><DashboardPage /></PrivateRoute>} />
        <Route path="/exam-prep" element={<PrivateRoute><ExamPrepPage /></PrivateRoute>} />
        <Route path="/resume-analyzer" element={<PrivateRoute><ResumeAnalyzerPage /></PrivateRoute>} />
        <Route path="/jobs" element={<PrivateRoute><JobBoardPage /></PrivateRoute>} />
        <Route path="/drafting-lab" element={<PrivateRoute><DraftingLabPage /></PrivateRoute>} />
        <Route path="/court-simulation" element={<PrivateRoute><CourtSimulationPage /></PrivateRoute>} />
        <Route path="/ai-interviewer" element={<PrivateRoute><AIInterviewerPage /></PrivateRoute>} />
        <Route path="/resume-builder" element={<PrivateRoute><ResumeBuilderPage /></PrivateRoute>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}