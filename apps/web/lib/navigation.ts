import {
  LayoutGrid,
  MessageCircle,
  Rss,
  Layers,
  Target,
  CalendarClock,
  ClipboardList,
  Activity,
  Settings,
  ListOrdered
} from 'lucide-react';

export type NavItem = {
  label: string;
  to: string;
  icon?: React.ComponentType<{ className?: string }>;
  children?: Array<{ label: string; to: string }>;
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

export const navSections: NavSection[] = [
  {
    title: 'Core',
    items: [
      { label: 'Overview', to: '/', icon: LayoutGrid },
      { label: 'WhatsApp', to: '/whatsapp', icon: MessageCircle }
    ]
  },
  {
    title: 'Automation',
    items: [
      { label: 'Feeds', to: '/feeds', icon: Rss },
      { label: 'Templates', to: '/templates', icon: Layers },
      { label: 'Targets', to: '/targets', icon: Target },
      { label: 'Automations', to: '/schedules', icon: CalendarClock },
      { label: 'Send Queue', to: '/queue', icon: ListOrdered }
    ]
  },
  {
    title: 'Monitoring',
    items: [
      { label: 'Stories', to: '/feed-items', icon: ClipboardList },
      { label: 'History', to: '/logs', icon: Activity }
    ]
  },
  {
    title: 'Settings',
    items: [
      { label: 'Settings', to: '/settings', icon: Settings }
    ]
  }
];

const navMap: Record<string, string> = {};
const addToMap = (item: NavItem) => {
  if (item.to) {
    navMap[item.to] = item.label;
  }
  if (item.children) {
    item.children.forEach((child) => addToMap({ label: child.label, to: child.to }));
  }
};

navSections.forEach((section) => section.items.forEach(addToMap));

export const navLookup = navMap;
