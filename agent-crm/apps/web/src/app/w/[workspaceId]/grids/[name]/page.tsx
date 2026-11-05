'use client';

import { useParams } from 'next/navigation';
import { GridView } from '@/components/grids/grid-view';

export default function RunGridPage() {
  const { name } = useParams<{ name: string }>();
  return <GridView name={name} />;
}
