import { useState } from 'react';
import { eyeTemplateLabels, eyeTemplateTypes, type EyeTemplate } from '@clinic/schemas';
import { imagesPath } from './imageApi';
import { go } from './session';

export default function EyeTemplatePicker({ patientId, visitId }: { patientId: string; visitId: string }) {
  const [type, setType] = useState<EyeTemplate>('anterior-od');
  return <div className="row eye-template-picker">
    <label>Eye diagram
      <select value={type} onChange={e => setType(e.target.value as EyeTemplate)}>
        {eyeTemplateTypes.map(t => <option key={t} value={t}>{eyeTemplateLabels[t]}</option>)}
      </select>
    </label>
    <button type="button" onClick={() => go(imagesPath(patientId, visitId, 'new', type))}>Open Drawing</button>
  </div>;
}
