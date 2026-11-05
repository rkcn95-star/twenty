'use client';

import { createContext, useContext } from 'react';
import type { Me, Metadata, MetaObject } from '@/lib/types';

type WorkspaceContextValue = { workspaceId: string; me: Me; metadata: Metadata; refreshMetadata: () => Promise<unknown> };

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export const useWorkspace = (): WorkspaceContextValue => {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside the workspace shell');
  return value;
};

export const useObjectByPlural = (plural: string): MetaObject | undefined =>
  useWorkspace().metadata.objects.find((object) => object.namePlural === plural);
