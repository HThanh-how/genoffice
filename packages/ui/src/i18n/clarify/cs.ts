import type zh from './zh'

const strings = {
  aiClarifyTitle: 'Několik rychlých otázek, aby stránka seděla přesně vám',
  aiClarifyDecide: 'Rozhodni za mě',
  aiClarifyDecideAnswer: '(rozhodni za mě)',
  aiClarifyMulti: 'Více možností',
  aiClarifyNext: 'Další',
  aiClarifyPrev: 'Předchozí',
  aiClarifyOther: 'Jiné (napište)',
  aiClarifySelected: 'Vybráno: {n}',
  aiClarifySkip: 'Přeskočit dotazník',
  aiClarifySubmit: 'Odeslat',
} satisfies Record<keyof typeof zh, string>

export default strings
