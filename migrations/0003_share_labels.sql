-- Give links optional admin-only labels without changing any existing URL or authorization.
ALTER TABLE shares ADD COLUMN label TEXT NOT NULL DEFAULT '';
