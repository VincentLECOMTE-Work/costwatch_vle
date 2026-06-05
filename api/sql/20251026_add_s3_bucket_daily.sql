-- ==== ACCOUNTS (pour éviter l'erreur "relation accounts n'existe pas") ====
CREATE TABLE IF NOT EXISTS accounts (
  account_id  text PRIMARY KEY,
  name        text,
  active      boolean DEFAULT true,
  created_at  timestamp DEFAULT now(),
  updated_at  timestamp DEFAULT now()
);

-- ==== S3 BUCKET DAILY : créer si absent (avec le bon schéma) ====
CREATE TABLE IF NOT EXISTS s3_bucket_daily (
  account_id     text NOT NULL,
  region         text NOT NULL,
  bucket         text NOT NULL,
  day            date NOT NULL,
  bytes_total    bigint NOT NULL DEFAULT 0,
  bytes_by_class jsonb  NOT NULL DEFAULT '{}'::jsonb,
  objects_total  bigint NOT NULL DEFAULT 0,
  created_at     timestamp DEFAULT now(),
  updated_at     timestamp DEFAULT now(),
  PRIMARY KEY (account_id, region, bucket, day)
);

DO $$
BEGIN
  -- Ancienne colonne mal nommée : la renommer si elle existe
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='s3_bucket_daily' AND column_name='total_bytes'
  ) THEN
    EXECUTE 'ALTER TABLE s3_bucket_daily RENAME COLUMN total_bytes TO bytes_total';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='s3_bucket_daily' AND column_name='bytes_total'
  ) THEN
    ALTER TABLE s3_bucket_daily ADD COLUMN bytes_total bigint NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='s3_bucket_daily' AND column_name='bytes_by_class'
  ) THEN
    ALTER TABLE s3_bucket_daily ADD COLUMN bytes_by_class jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='s3_bucket_daily' AND column_name='objects_total'
  ) THEN
    ALTER TABLE s3_bucket_daily ADD COLUMN objects_total bigint NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Indexes utiles
CREATE INDEX IF NOT EXISTS idx_s3_bucket_daily_bucket ON s3_bucket_daily(bucket);
CREATE INDEX IF NOT EXISTS idx_s3_bucket_daily_day    ON s3_bucket_daily(day);
