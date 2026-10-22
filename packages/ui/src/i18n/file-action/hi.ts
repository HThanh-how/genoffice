import type { zh } from './zh'

export const strings = {
  title: 'इस फ़ाइल कार्रवाई की अनुमति दें?',
  approve: 'स्वीकृत करें',
  deny: 'अस्वीकार करें',
  create_folder: 'फ़ोल्डर बनाएँ',
  move_file: 'फ़ाइल ले जाएँ या नाम बदलें',
  delete_file: 'सिस्टम के कूड़ेदान में ले जाएँ',
  list_folder: 'फ़ोल्डर सूची',
  merge_documents: 'दस्तावेज़ों को नई फ़ाइल में मर्ज करें',
  export_pdf: 'सहेजी गई फ़ाइल PDF में निर्यात करें',
} satisfies Record<keyof typeof zh, string>
