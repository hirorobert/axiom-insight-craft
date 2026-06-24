-- Drop the original unauthenticated policies by their exact names
DROP POLICY IF EXISTS "Allow public upload to trial-balance-files" ON storage.objects;
DROP POLICY IF EXISTS "Allow public read from trial-balance-files"  ON storage.objects;

-- Confirm the bucket is private (it was created with public = false in migration 1,
-- but this makes the intent explicit and safe to re-run)
UPDATE storage.buckets
SET public = false
WHERE id = 'trial-balance-files';

-- INSERT: authenticated users may only upload into their own folder
CREATE POLICY "Users can upload their own trial balance files"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'trial-balance-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- SELECT: authenticated users may only read their own files
CREATE POLICY "Users can read their own trial balance files"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'trial-balance-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- UPDATE: authenticated users may only update their own files
CREATE POLICY "Users can update their own trial balance files"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'trial-balance-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- DELETE: authenticated users may only delete their own files
CREATE POLICY "Users can delete their own trial balance files"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'trial-balance-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
