import './index.css';

function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="icp-footer">
      <p>© {year} 汉尔斯再生医学科技（河北）有限公司. All rights reserved.</p>
      <p>
        <a href="https://beian.miit.gov.cn" rel="noreferrer" target="_blank">
          冀ICP备2023032637号
        </a>
      </p>
    </footer>
  );
}

export default Footer;
