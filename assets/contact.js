// クローラー・スパム収集対策のため、連絡先メールアドレスをHTMLに直接記載せず、
// 実行時に組み立てて表示する。data-contact-email属性を持つ要素に反映する。
(function () {
  var user = ['n', 'o', 'r', 'i', 'n', 'o', 'r', 'i', '1', '9', '7', '9', '2', '4'].join('');
  var domain = ['g', 'm', 'a', 'i', 'l', '.', 'c', 'o', 'm'].join('');
  var email = user + '@' + domain;

  document.querySelectorAll('[data-contact-email]').forEach(function (el) {
    el.textContent = email;
    if (el.tagName === 'A') {
      el.href = 'mailto:' + email;
    }
  });
})();
