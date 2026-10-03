import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { Button } from '@helmet/ui';
import { InlineError } from '../../components/States';
import { api } from '../../lib/api';
import { useInvalidateEmergency } from './hooks';

/** Optional photo. The server validates, strips metadata and re-encodes it. */
export function PhotoUploader({ hasPhoto }: { hasPhoto: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const invalidate = useInvalidateEmergency();
  const photo = useQuery({
    queryKey: ['emergency', 'photo', hasPhoto],
    queryFn: () => api.blob('/customer/emergency-profile/photo').then((r) => r.blob),
    enabled: hasPhoto,
  });
  const url = useMemo(() => (photo.data ? URL.createObjectURL(photo.data) : null), [photo.data]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('photo', file);
      return api.upload('/customer/emergency-profile/photo', form);
    },
    onSuccess: () => invalidate(),
  });
  const remove = useMutation({
    mutationFn: () => api.delete('/customer/emergency-profile/photo'),
    onSuccess: () => invalidate(),
  });

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Photo (optional)</span>
      <div className="flex items-center gap-4">
        <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl bg-canvas-soft text-xs text-body">
          {hasPhoto && url ? (
            <img src={url} alt="Your emergency photo" className="h-full w-full object-cover" />
          ) : (
            'No photo'
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="subtle"
            size="sm"
            loading={upload.isPending}
            onClick={() => input.current?.click()}
          >
            {hasPhoto ? 'Replace' : 'Upload photo'}
          </Button>
          {hasPhoto && (
            <Button
              variant="ghost"
              size="sm"
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove
            </Button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          aria-label="Choose a photo"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.target.value = '';
          }}
        />
      </div>
      <p className="text-xs text-body">JPEG, PNG or WebP, up to 5 MB. Location data is removed.</p>
      <InlineError error={upload.error ?? remove.error} />
    </div>
  );
}
