import type { DrugReferenceInput } from './drugReference.js';

/**
 * STARTER medication / allergen reference, bundled so the safety check works
 * out of the box. It is NOT yet signed off: `approval` is empty on purpose.
 *
 * To roll out the clinic's approved list:
 *   1. copy this object to a JSON file and edit it (add drugs, brands, classes);
 *   2. fill `approval.approvedBy` and `approval.approvedAt` once the Doctor has
 *      reviewed it, and raise `version`;
 *   3. point DRUG_REFERENCE_PATH at the file.
 * Nothing else in the code needs to change.
 */
export const DEFAULT_DRUG_REFERENCE: DrugReferenceInput = {
  version: 1,
  approval: {
    approvedBy: null,
    approvedAt: null,
    note: 'Starter list pending review by the clinic Doctor (FR-5.6.6).',
  },
  classes: [
    {
      id: 'penicillin',
      label: 'penicillins',
      aliases: ['penicillins', 'beta lactam', 'beta lactams', 'penicillin antibiotics'],
      relatedClasses: [
        { classId: 'cephalosporin', note: 'cephalosporins can cross-react with penicillins' },
      ],
    },
    {
      id: 'cephalosporin',
      label: 'cephalosporins',
      aliases: ['cephalosporins', 'cefalosporin'],
      relatedClasses: [
        { classId: 'penicillin', note: 'penicillins can cross-react with cephalosporins' },
      ],
    },
    {
      id: 'sulfonamide-antibiotic',
      label: 'sulfonamide antibiotics',
      aliases: ['sulfa', 'sulfonamide', 'sulfonamides', 'sulfa drugs', 'sulpha', 'sulfonamide antibiotics'],
      relatedClasses: [
        {
          classId: 'carbonic-anhydrase-inhibitor',
          note: 'non-antibiotic sulfonamides; cross-reactivity is uncommon but reported',
        },
      ],
    },
    {
      id: 'carbonic-anhydrase-inhibitor',
      label: 'carbonic anhydrase inhibitors',
      aliases: ['carbonic anhydrase inhibitors', 'cai'],
      relatedClasses: [
        { classId: 'sulfonamide-antibiotic', note: 'contain a sulfonamide group' },
      ],
    },
    {
      id: 'nsaid',
      label: 'NSAIDs',
      aliases: ['nsaid', 'nsaids', 'anti inflammatory', 'non steroidal anti inflammatory'],
      relatedClasses: [],
    },
    {
      id: 'fluoroquinolone',
      label: 'fluoroquinolones',
      aliases: ['fluoroquinolone', 'fluoroquinolones', 'quinolone', 'quinolones'],
      relatedClasses: [],
    },
    {
      id: 'aminoglycoside',
      label: 'aminoglycosides',
      aliases: ['aminoglycoside', 'aminoglycosides'],
      relatedClasses: [],
    },
    {
      id: 'beta-blocker',
      label: 'beta blockers',
      aliases: ['beta blocker', 'beta blockers', 'beta adrenergic blocker'],
      relatedClasses: [],
    },
    {
      id: 'prostaglandin-analog',
      label: 'prostaglandin analogues',
      aliases: ['prostaglandin', 'prostaglandins', 'prostaglandin analogs', 'prostaglandin analogues'],
      relatedClasses: [],
    },
    {
      id: 'alpha-2-agonist',
      label: 'alpha-2 agonists',
      aliases: ['alpha 2 agonist', 'alpha 2 agonists', 'alpha agonist'],
      relatedClasses: [],
    },
    {
      id: 'corticosteroid',
      label: 'corticosteroids',
      aliases: ['corticosteroid', 'corticosteroids', 'steroid', 'steroids'],
      relatedClasses: [],
    },
  ],
  drugs: [
    // Penicillins
    { name: 'penicillin', aliases: ['penicillin v', 'penicillin g', 'pen vk'], classes: ['penicillin'] },
    { name: 'amoxicillin', aliases: ['amoxil'], classes: ['penicillin'] },
    { name: 'ampicillin', aliases: [], classes: ['penicillin'] },
    { name: 'dicloxacillin', aliases: [], classes: ['penicillin'] },
    { name: 'flucloxacillin', aliases: [], classes: ['penicillin'] },
    { name: 'piperacillin', aliases: [], classes: ['penicillin'] },
    {
      name: 'amoxicillin clavulanate',
      aliases: ['co amoxiclav', 'amoxicillin and clavulanic acid', 'augmentin'],
      classes: ['penicillin'],
    },
    // Cephalosporins
    { name: 'cephalexin', aliases: ['cefalexin', 'keflex'], classes: ['cephalosporin'] },
    { name: 'cefazolin', aliases: [], classes: ['cephalosporin'] },
    { name: 'cefuroxime', aliases: ['zinacef'], classes: ['cephalosporin'] },
    { name: 'ceftriaxone', aliases: ['rocephin'], classes: ['cephalosporin'] },
    { name: 'cefixime', aliases: [], classes: ['cephalosporin'] },
    { name: 'cefepime', aliases: [], classes: ['cephalosporin'] },
    // Sulfonamide antibiotics
    { name: 'sulfamethoxazole', aliases: [], classes: ['sulfonamide-antibiotic'] },
    { name: 'sulfacetamide', aliases: [], classes: ['sulfonamide-antibiotic'] },
    { name: 'sulfadiazine', aliases: [], classes: ['sulfonamide-antibiotic'] },
    { name: 'sulfasalazine', aliases: [], classes: ['sulfonamide-antibiotic'] },
    {
      name: 'cotrimoxazole',
      aliases: ['co trimoxazole', 'trimethoprim sulfamethoxazole', 'bactrim'],
      classes: ['sulfonamide-antibiotic'],
    },
    // Carbonic anhydrase inhibitors
    { name: 'dorzolamide', aliases: ['trusopt'], classes: ['carbonic-anhydrase-inhibitor'] },
    { name: 'brinzolamide', aliases: ['azopt'], classes: ['carbonic-anhydrase-inhibitor'] },
    { name: 'acetazolamide', aliases: ['diamox'], classes: ['carbonic-anhydrase-inhibitor'] },
    // NSAIDs
    { name: 'ibuprofen', aliases: ['advil', 'motrin'], classes: ['nsaid'] },
    { name: 'naproxen', aliases: ['aleve'], classes: ['nsaid'] },
    { name: 'diclofenac', aliases: ['voltaren'], classes: ['nsaid'] },
    { name: 'ketorolac', aliases: ['acular'], classes: ['nsaid'] },
    { name: 'nepafenac', aliases: ['nevanac'], classes: ['nsaid'] },
    { name: 'bromfenac', aliases: ['xibrom', 'bromday'], classes: ['nsaid'] },
    { name: 'indomethacin', aliases: ['indometacin'], classes: ['nsaid'] },
    { name: 'aspirin', aliases: ['acetylsalicylic acid', 'asa'], classes: ['nsaid'] },
    { name: 'mefenamic acid', aliases: ['ponstan'], classes: ['nsaid'] },
    // Fluoroquinolones
    { name: 'ciprofloxacin', aliases: ['cipro'], classes: ['fluoroquinolone'] },
    { name: 'moxifloxacin', aliases: ['vigamox', 'avelox'], classes: ['fluoroquinolone'] },
    { name: 'levofloxacin', aliases: ['levaquin', 'cravit'], classes: ['fluoroquinolone'] },
    { name: 'ofloxacin', aliases: ['ocuflox'], classes: ['fluoroquinolone'] },
    { name: 'gatifloxacin', aliases: ['zymar'], classes: ['fluoroquinolone'] },
    { name: 'norfloxacin', aliases: [], classes: ['fluoroquinolone'] },
    // Aminoglycosides
    { name: 'gentamicin', aliases: ['garamycin'], classes: ['aminoglycoside'] },
    { name: 'tobramycin', aliases: ['tobrex'], classes: ['aminoglycoside'] },
    { name: 'neomycin', aliases: [], classes: ['aminoglycoside'] },
    { name: 'amikacin', aliases: [], classes: ['aminoglycoside'] },
    // Glaucoma and anti-inflammatory eye drops
    { name: 'timolol', aliases: ['timoptic'], classes: ['beta-blocker'] },
    { name: 'betaxolol', aliases: ['betoptic'], classes: ['beta-blocker'] },
    { name: 'latanoprost', aliases: ['xalatan'], classes: ['prostaglandin-analog'] },
    { name: 'bimatoprost', aliases: ['lumigan'], classes: ['prostaglandin-analog'] },
    { name: 'travoprost', aliases: ['travatan'], classes: ['prostaglandin-analog'] },
    { name: 'brimonidine', aliases: ['alphagan'], classes: ['alpha-2-agonist'] },
    { name: 'prednisolone', aliases: ['pred forte'], classes: ['corticosteroid'] },
    { name: 'dexamethasone', aliases: ['maxidex'], classes: ['corticosteroid'] },
    { name: 'fluorometholone', aliases: ['fml'], classes: ['corticosteroid'] },
    // Fixed combinations belong to the classes of every component.
    {
      name: 'dorzolamide timolol',
      aliases: ['cosopt'],
      classes: ['carbonic-anhydrase-inhibitor', 'beta-blocker'],
    },
  ],
};
