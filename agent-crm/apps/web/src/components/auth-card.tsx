import { Boxes } from 'lucide-react';

export function AuthCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-app p-4">
      <div className="w-full max-w-[360px] rounded-lg border bg-background p-6">
        <div className="mb-5 flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-[4px] bg-primary text-primary-foreground">
            <Boxes className="size-3.5" />
          </span>
          <span className="text-[13px] font-semibold">Agent CRM</span>
        </div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {description ? <p className="mt-1 text-muted-foreground">{description}</p> : null}
        <div className="mt-4">{children}</div>
      </div>
    </main>
  );
}
