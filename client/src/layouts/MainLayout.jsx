import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/layout/Sidebar';
import TopBar from '../components/layout/TopBar';
import MobileNav from '../components/layout/MobileNav';

const MainLayout = () => (
  <div className="gradient-surface min-h-screen">
    <div className="mx-auto flex max-w-[1600px] flex-col gap-6 px-4 py-6 lg:flex-row">
      <Sidebar />
      <div className="flex min-h-screen flex-1 flex-col gap-6">
        <TopBar />
        <main className="space-y-10 pb-24 lg:pb-16">
          <Outlet />
        </main>
      </div>
    </div>
    <MobileNav />
  </div>
);

export default MainLayout;
