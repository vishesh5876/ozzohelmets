-- Print Designs: artwork may be layered over the white Safety ID panel (QR, PIN and Safety ID
-- text are always kept clear). Additive only. Existing versions keep false, so every batch
-- already printed with them renders exactly as before; the service sets true for new designs.
ALTER TABLE "print_designs" ADD COLUMN "artwork_on_top" BOOLEAN NOT NULL DEFAULT false;
