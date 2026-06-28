-- Create storage bucket for trial balance files
INSERT INTO storage.buckets (id, name, public)
VALUES ('trial-balance-files', 'trial-balance-files', false);

-- Create table to track trial balance uploads
CREATE TABLE public.trial_balance_uploads (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  company_name TEXT,
  uploaded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  processed_at TIMESTAMP WITH TIME ZONE,
  processing_result JSONB
);

-- Enable RLS (public access for demo - no auth required)
ALTER TABLE public.trial_balance_uploads ENABLE ROW LEVEL SECURITY;

-- Allow public insert for demo purposes
CREATE POLICY "Allow public insert" 
ON public.trial_balance_uploads 
FOR INSERT 
WITH CHECK (true);

-- Allow public select for demo purposes
CREATE POLICY "Allow public select" 
ON public.trial_balance_uploads 
FOR SELECT 
USING (true);

-- Allow public update for demo purposes
CREATE POLICY "Allow public update" 
ON public.trial_balance_uploads 
FOR UPDATE 
USING (true);

-- Storage policies for trial balance files bucket
CREATE POLICY "Allow public upload to trial-balance-files"
ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'trial-balance-files');

CREATE POLICY "Allow public read from trial-balance-files"
ON storage.objects
FOR SELECT
USING (bucket_id = 'trial-balance-files');