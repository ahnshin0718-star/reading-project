module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않은 요청 방식입니다.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Vercel 환경 변수에 GEMINI_API_KEY가 설정되지 않았습니다.' });
  }

  const { title, publisher = '', difficulty = '초등 고학년', extraNote = '' } = req.body || {};

  if (!title || !title.trim()) {
    return res.status(400).json({ error: '책 제목을 입력해 주세요.' });
  }

  try {
    let matchedBook = null;
    if (process.env.KAKAO_REST_API_KEY) {
      const searchQuery = encodeURIComponent(`${title} ${publisher}`.trim());
      const kakaoRes = await fetch(
        `https://dapi.kakao.com/v3/search/book?query=${searchQuery}&size=5`,
        {
          headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}` },
        }
      );

      if (kakaoRes.ok) {
        const kakaoData = await kakaoRes.json();
        const docs = kakaoData.documents || [];
        if (docs.length > 0) {
          matchedBook =
            docs.find((doc) =>
              publisher ? doc.publisher.replace(/\s/g, '').includes(publisher.replace(/\s/g, '')) : true
            ) || docs[0];
        }
      }
    }

    const bookContext = matchedBook
      ? `- 공식 도서명: ${matchedBook.title}\n- 저자: ${(matchedBook.authors || []).join(', ')}\n- 출판사: ${matchedBook.publisher}\n- 줄거리 요약: ${matchedBook.contents || '없음'}`
      : `- 입력된 책 제목: ${title}\n- 입력된 출판사: ${publisher || '미입력'}`;

    const prompt = `당신은 친절하고 전문적인 독서 지도 교사입니다. 아래 도서 정보를 바탕으로 독서 퀴즈 5문제를 출제해 주세요.

[도서 정보]
${bookContext}
- 추가 참고 메모: ${extraNote || '없음'}
- 대상 난이도: ${difficulty}

[출제 규칙]
1. 반드시 실제 책의 줄거리, 등장인물, 핵심 사건과 교훈에 기반해 정확하게 출제할 것.
2. 난이도(${difficulty})에 맞는 어휘와 질문 깊이를 사용할 것.
3. 각 문제는 4지선다형 객관식이며, 정답은 반드시 1개만 명확히 존재할 것.
4. 오답을 골라도 내용을 이해할 수 있도록 친절하고 구체적인 해설을 적을 것.`;

    const requestBody = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              question: { type: 'STRING' },
              options: { type: 'ARRAY', items: { type: 'STRING' } },
              answerIndex: { type: 'INTEGER' },
              explanation: { type: 'STRING' },
            },
            required: ['question', 'options', 'answerIndex', 'explanation'],
          },
        },
      },
    });

    // 서버 혼잡(503/429) 시 1.5초 간격으로 최대 3회 자동 재시도
    let geminiRes;
    let geminiData;
    for (let attempt = 1; attempt <= 3; attempt++) {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
        }
      );
      geminiData = await geminiRes.json();

      if (geminiRes.ok) break;
      if ((geminiRes.status === 503 || geminiRes.status === 429) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      break;
    }

    if (!geminiRes.ok) {
      console.error('Gemini API Error:', geminiData);
      return res.status(500).json({
        error: '현재 AI 서버에 접속자가 많습니다. 5초 후 다시 버튼을 눌러 주세요.',
      });
    }

    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    const quizzes = JSON.parse(rawText);

    return res.status(200).json({
      bookInfo: matchedBook
        ? {
            title: matchedBook.title,
            authors: (matchedBook.authors || []).join(', '),
            publisher: matchedBook.publisher,
            thumbnail: matchedBook.thumbnail,
          }
        : {
            title: title.trim(),
            authors: '',
            publisher: publisher.trim() || '출판사 미입력',
            thumbnail: '',
          },
      quizzes,
    });
  } catch (err) {
    console.error('Server Error:', err);
    return res.status(500).json({ error: '퀴즈를 생성하는 중 서버 오류가 발생했습니다.' });
  }
};
