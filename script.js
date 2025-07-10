// ⛱️ Loading إخفاء
window.addEventListener('load', ()=> {
  document.getElementById('loading').style.display = 'none';
});

// 🔍 Scroll Reveal
const reveals = document.querySelectorAll('.reveal');
window.addEventListener('scroll', ()=>{
  reveals.forEach(el=>{
    let top = el.getBoundingClientRect().top;
    if (top < window.innerHeight - 100) {
      el.classList.add('active');
    }
  });
});

// ☰ Toggle menu للموبايل
document.querySelector('.nav-toggle').addEventListener('click', ()=>{
  const nav = document.querySelector('.nav-desktop');
  nav.style.display = nav.style.display === 'flex' ? 'none' : 'flex';
});
console.log("جافاسكربت تعمل ✅");
