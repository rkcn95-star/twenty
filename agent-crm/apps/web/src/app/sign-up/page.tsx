'use client';

import Link from 'next/link';
import { MailCheck } from 'lucide-react';
import { useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

export default function SignUpPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));
    setPending(true);
    setError(null);
    const { error: failure } = await authClient.signUp.email({
      email, name: String(form.get('name')), password: String(form.get('password')), callbackURL: '/w',
    });
    setPending(false);
    if (failure) setError(failure.message ?? 'Sign-up failed');
    else setSentTo(email);
  };

  if (sentTo) {
    return (
      <AuthCard title="Check your email">
        <div className="flex items-start gap-2 text-muted-foreground">
          <MailCheck className="mt-0.5 size-4 shrink-0 text-green-600" />
          <p>We sent a verification link to <strong className="text-foreground">{sentTo}</strong>. Open it to finish signing up.</p>
        </div>
        <p className="mt-4"><Link className="text-blue hover:underline" href="/sign-in">Back to sign in</Link></p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create your account" description="Passwords need at least 10 characters.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" autoComplete="name" required />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        </div>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <Button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create account'}</Button>
        {process.env.NEXT_PUBLIC_GOOGLE_AUTH === 'true' ? (
          <Button type="button" variant="outline" onClick={() => authClient.signIn.social({ provider: 'google', callbackURL: '/w' })}>
            Continue with Google
          </Button>
        ) : null}
      </form>
      <p className="mt-4 text-muted-foreground">
        Already have an account? <Link className="text-blue hover:underline" href="/sign-in">Sign in</Link>
      </p>
    </AuthCard>
  );
}
