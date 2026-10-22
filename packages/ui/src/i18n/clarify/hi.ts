import type zh from './zh'

const strings = {
  aiActionStep: 'चरण {step}/{total}: {text} (रद्द करने के लिए Esc)',
  aiActionApprove: 'अनुमति दें',
  aiActionDeny: 'अस्वीकार करें',
  aiActionConfirm: 'इस कार्रवाई की अनुमति दें?',
  aiActionIndex: 'इंडेक्स खोलें',
  aiActionSettings: 'सेटिंग खोलें',
  aiActionNewChat: 'नई चैट शुरू करें',
  aiActionPrint: 'फ़ाइल → प्रिंट खोलें',
  aiActionExportPdf: 'PDF निर्यात करें',
  aiActionFile: 'फ़ाइल मेनू खोलें',
  aiActionHandoff: 'संवाद में आगे बढ़ें; परिणाम आपकी पसंद पर निर्भर है।',
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
