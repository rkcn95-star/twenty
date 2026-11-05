export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type RequestInit = { method?: string; body?: unknown; workspaceId?: string };

export const request = async <TResult>(path: string, init: RequestInit = {}): Promise<TResult> => {
  const response = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init.workspaceId ? { 'x-workspace-id': init.workspaceId } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error ?? data?.message ?? response.statusText, response.status);
  return data as TResult;
};

// Every tool the server offers, in the signed-in user's own permissions.
export const callTool = async <TResult = unknown>(workspaceId: string, name: string, args: object = {}): Promise<TResult> =>
  (await request<{ result: TResult }>(`/v1/tools/${name}`, { method: 'POST', body: args, workspaceId })).result;

export const manage = <TResult = unknown>(workspaceId: string, suffix: string, init: Omit<RequestInit, 'workspaceId'> = {}) =>
  request<TResult>(`/v1/workspaces/${workspaceId}${suffix}`, { ...init, workspaceId });
