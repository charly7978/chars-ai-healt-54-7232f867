
CREATE TABLE public.perf_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  session_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  fps numeric,
  jitter_ms numeric,
  dropped_estimate integer DEFAULT 0,
  frames integer DEFAULT 0,
  stages jsonb DEFAULT '{}'::jsonb,
  device jsonb DEFAULT '{}'::jsonb,
  camera jsonb DEFAULT '{}'::jsonb,
  pipeline jsonb DEFAULT '{}'::jsonb,
  app_version text,
  consent_given boolean NOT NULL DEFAULT false
);

ALTER TABLE public.perf_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own perf snapshots"
  ON public.perf_snapshots FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own perf snapshots"
  ON public.perf_snapshots FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own perf snapshots"
  ON public.perf_snapshots FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX idx_perf_snapshots_user_created ON public.perf_snapshots (user_id, created_at DESC);
CREATE INDEX idx_perf_snapshots_session ON public.perf_snapshots (session_id);
