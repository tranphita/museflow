(() => {
  const explicitRefusal =
    /(?:i|we)\s+(?:am\s+)?sorry[\s\S]{0,180}(?:cannot|can't|unable|won't)|(?:cannot|can't|couldn't|unable to|not able to)\s+(?:help|assist|create|generate|make|produce|fulfill|complete|comply)|(?:request|prompt).{0,100}(?:violat|disallowed|restricted|not allowed)|(?:policy|safety).{0,100}(?:prevent|restrict|unable)|generation (?:was )?(?:declined|blocked)|content (?:is )?not allowed|i can't comply/i;
  const inability =
    /(?:không tạo được|không thể tạo|chưa thể tạo|không thực hiện được|vẫn không tạo được|không làm được)/i;
  const sceneContext = /(?:cảnh|bản|đoạn|video|ảnh|nội dung|yêu cầu|này)/i;
  const offerAlternative =
    /(?:bản|phiên bản|phương án)\s+tương\s+đương|tương\s+đương.{0,100}(?:bám|theo|kịch bản)|muốn.{0,100}(?:tạo mới|thử lại|làm lại)|(?:would you like|do you want|want me to).{0,100}(?:create|make|generate|try)|equivalent alternative/i;

  function isRefusalContext(context) {
    const text = String(context || '');
    return (
      explicitRefusal.test(text) ||
      (inability.test(text) && (sceneContext.test(text) || offerAlternative.test(text)))
    );
  }

  function isClearRefusal(context) {
    const text = String(context || '');
    return inability.test(text) && sceneContext.test(text) && offerAlternative.test(text);
  }

  globalThis.MusetaRefusal = Object.freeze({ isRefusalContext, isClearRefusal });
})();
