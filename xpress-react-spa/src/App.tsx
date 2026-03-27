import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import Onboarding from './pages/Onboarding';
import ProjectSelector from './pages/ProjectSelector';
import Editor from './pages/Editor';
import SplitView from './pages/SplitView';
import VisualEditor from './pages/VisualEditor';
import DeployDashboard from './pages/DeployDashboard';
import SharedLayout from './components/SharedLayout';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />

        <Route path="/app" element={<SharedLayout />}>
          <Route index element={<Navigate to="projects" replace />} />
          <Route path="onboarding" element={<Onboarding />} />
          <Route path="projects" element={<ProjectSelector />} />
          <Route path="editor" element={<Editor />} />
          <Route path="editor/split-view" element={<SplitView />} />
          <Route path="editor/visual" element={<VisualEditor />} />
          <Route path="deploy" element={<DeployDashboard />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
