-- Consent types captured on the tablet intake form (QA 8.4).
--
-- The patient ticks treatment and clinical photography alongside the data
-- privacy notice, so both need a ConsentType of their own; previously only
-- DATA_PROCESSING and REMINDER existed and the tablet's flags were dropped.

ALTER TYPE "ConsentType" ADD VALUE IF NOT EXISTS 'TREATMENT';
ALTER TYPE "ConsentType" ADD VALUE IF NOT EXISTS 'CLINICAL_PHOTOGRAPHY';
