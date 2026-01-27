import React from 'react';
import { Routes, Route } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import OverviewPage from './pages/OverviewPage';
import WhatsAppPage from './pages/WhatsAppPage';
import FeedsPage from './pages/FeedsPage';
import TemplatesPage from './pages/TemplatesPage';
import TargetsPage from './pages/TargetsPage';
import SchedulesPage from './pages/SchedulesPage';
import SettingsPage from './pages/SettingsPage';
import LogsPage from './pages/LogsPage';
import FeedItemsPage from './pages/FeedItemsPage';

const App = () => (
  <Routes>
    <Route element={<MainLayout />}>
      <Route index element={<OverviewPage />} />
      <Route path="whatsapp" element={<WhatsAppPage />} />
      <Route path="feeds" element={<FeedsPage />} />
      <Route path="templates" element={<TemplatesPage />} />
      <Route path="targets" element={<TargetsPage />} />
      <Route path="schedules" element={<SchedulesPage />} />
      <Route path="logs" element={<LogsPage />} />
      <Route path="feed-items" element={<FeedItemsPage />} />
      <Route path="settings" element={<SettingsPage />} />
    </Route>
  </Routes>
);

export default App;
