'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('theme', next ? 'dark' : 'light'); } catch { /* private mode */ }
    setDark(next);
  };
  return (
    <Button variant="ghost" size="sm" className="w-full justify-start px-2 text-muted-foreground hover:bg-black/5" aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle}>
      {dark ? <Sun /> : <Moon />} {dark ? 'Light theme' : 'Dark theme'}
    </Button>
  );
}
