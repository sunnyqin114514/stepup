import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import HomePage from "./pages/HomePage";
import PlannerPage from "./pages/PlannerPage";
import SchedulePage from "./pages/SchedulePage";
import CheckInPage from "./pages/CheckInPage";
import ProgressPage from "./pages/ProgressPage";
import KnowledgePage from "./pages/KnowledgePage";
import ReviewPage from "./pages/ReviewPage";
import MembershipPage from "./pages/MembershipPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="planner" element={<PlannerPage />} />
          <Route path="schedule" element={<SchedulePage />} />
          <Route path="checkin" element={<CheckInPage />} />
          <Route path="progress" element={<ProgressPage />} />
          <Route path="knowledge" element={<KnowledgePage />} />
          <Route path="review" element={<ReviewPage />} />
          <Route path="membership" element={<MembershipPage />} />
          <Route path="*" element={<HomePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
