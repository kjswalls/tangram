import clsx, { type ClassValue } from 'clsx';

/** The one class-name joiner. Kept separate so components import one thing. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
