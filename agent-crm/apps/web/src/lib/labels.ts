import type { MetaObject } from './types';

export const humanize = (name: string): string => {
  const spaced = name.replaceAll('_', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export const singularLabel = (object: MetaObject): string => humanize(object.nameSingular);
