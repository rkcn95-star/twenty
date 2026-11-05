'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';
import { safeNext } from '@/lib/next-url';

function SignInForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error: failure } = await authClient.signIn.email({ email: String(form.get('email')), password: String(form.get('password')) });
    setPending(false);
    if (failure) {
      setError(failure.status === 403 ? 'Verify your email first. Check your inbox for the link.' : (failure.message ?? 'Sign-in failed'));
      return;
    }
    router.push(next ?? '/w');
  };

  return (
    <AuthCard title="Sign in" description="Use the email and password you signed up with.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <Button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</Button>
        {process.env.NEXT_PUBLIC_GOOGLE_AUTH === 'true' ? (
          <Button type="button" variant="outline" onClick={() => authClient.signIn.social({ provider: 'google', callbackURL: next ?? '/w' })}>
            Continue with Google
          </Button>
        ) : null}
      </form>
      <p className="mt-4 text-muted-foreground">
        New here? <Link className="text-blue hover:underline" href={next ? `/sign-up?next=${encodeURIComponent(next)}` : '/sign-up'}>Create an account</Link>
      </p>
    </AuthCard>
  );
}

export default function SignInPage() {
  return <Suspense><SignInForm /></Suspense>;
}
