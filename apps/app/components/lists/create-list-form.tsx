'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Make a list of your own. The only field a list has is its name. */
export function CreateListForm({ onCreate }: { onCreate: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);

  return (
    <form
      data-testid="create-list"
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim() || pending) return;
        setPending(true);
        try {
          await onCreate(name);
          setName('');
        } finally {
          setPending(false);
        }
      }}
    >
      <Input
        aria-label="New list name"
        placeholder="Kitchen Chinese"
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="max-w-xs"
      />
      <Button type="submit" disabled={!name.trim() || pending}>
        {pending ? 'Creating…' : 'Create list'}
      </Button>
    </form>
  );
}
