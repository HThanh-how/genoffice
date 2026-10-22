import type zh from './zh'

const strings = {
  aiClarifyTitle: 'पेज को आपके अनुरूप बनाने के लिए कुछ छोटे प्रश्न',
  aiClarifyDecide: 'मेरे लिए तय करें',
  aiClarifyDecideAnswer: '(मेरे लिए तय करें)',
  aiClarifyMulti: 'एकाधिक चयन',
  aiClarifyNext: 'अगला',
  aiClarifyPrev: 'पिछला',
  aiClarifyOther: 'अन्य (स्वयं लिखें)',
  aiClarifySelected: '{n} चयनित',
  aiClarifySkip: 'सर्वेक्षण छोड़ें',
  aiClarifySubmit: 'भेजें',
} satisfies Record<keyof typeof zh, string>

export default strings
