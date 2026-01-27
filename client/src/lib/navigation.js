import {
  LayoutGrid,
  MessageCircle,
  Rss,
  Layers,
  Target,
  CalendarClock,
  ClipboardList,
  Activity,
  Settings
} from 'lucide-react';

export const navSections = [
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
      { label: 'Schedules', to: '/schedules', icon: CalendarClock }
    ]
  },
  {
    title: 'Monitoring',
    items: [
      { label: 'Feed Items', to: '/feed-items', icon: ClipboardList },
      { label: 'Logs', to: '/logs', icon: Activity }
    ]
  },
  {
    title: 'Settings Tree',
    items: [
      {
        label: 'Settings',
        to: '/settings',
        icon: Settings,
        children: [
          { label: 'Retention', to: '/settings#retention' },
          { label: 'Delays', to: '/settings#delays' },
          { label: 'Dedupe', to: '/settings#dedupe' }
        ]
      }
    ]
  }
];

const navMap = {};
const addToMap = (item) => {
  if (item.to) {
    navMap[item.to] = item.label;
  }
  if (item.children) {
    item.children.forEach(addToMap);
  }
};

navSections.forEach((section) => section.items.forEach(addToMap));

export const navLookup = navMap;
