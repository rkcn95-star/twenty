// Only same-site paths may be used as a post-sign-in destination.
export const safeNext = (value: string | null): string | null => (value && value.startsWith('/') && !value.startsWith('//') ? value : null);
