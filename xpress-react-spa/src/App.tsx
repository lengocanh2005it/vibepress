import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import Onboarding from "./pages/Onboarding";
import ProjectSelector from "./pages/ProjectSelector";
import Editor from "./pages/Editor";
import SplitView from "./pages/SplitView";
import VisualEditor from "./pages/VisualEditor";
import DeployDashboard from "./pages/DeployDashboard";
import TemplateStore from "./pages/TemplateStore";
import SharedLayout from "./components/SharedLayout";
import { UserProvider } from "./context/UserContext";

function App() {
  return (
    <UserProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />

          <Route path="app" element={<SharedLayout />}>
            <Route index element={<Navigate to="projects" replace />} />
            <Route path="onboarding" element={<Onboarding />} />
            <Route path="projects" element={<ProjectSelector />} />
            <Route path="editor" element={<Editor />} />
            <Route path="editor/split-view" element={<SplitView />} />
            <Route path="editor/visual" element={<VisualEditor />} />
            <Route path="deploy" element={<DeployDashboard />} />
          </Route>

          <Route path="template-store" element={<TemplateStore />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </UserProvider>
  );
}

export default App;
