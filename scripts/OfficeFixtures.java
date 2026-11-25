import java.awt.geom.Rectangle2D;
import java.nio.file.Files;
import java.nio.file.Path;
import org.apache.poi.hwpf.HWPFDocument;
import org.apache.poi.hslf.usermodel.HSLFSlideShow;
import org.apache.poi.xslf.usermodel.XMLSlideShow;
import org.apache.poi.xwpf.usermodel.XWPFDocument;

class OfficeFixtures {
    public static void main(String[] args) throws Exception {
        Path directory = Path.of(args[0]);
        String title = "课程计划与中文期末复习资料";
        String slideTitle = "中文幻灯片演示";
        try (var input = Files.newInputStream(Path.of(args[1]));
             var doc = new HWPFDocument(input);
             var output = Files.newOutputStream(directory.resolve("fixture.doc"))) {
            doc.getRange().insertBefore(title + "\r");
            doc.write(output);
        }
        try (var input = Files.newInputStream(directory.resolve("fixture.doc"));
             var doc = new HWPFDocument(input)) {
            if (!doc.getRange().text().contains(title)) throw new IllegalStateException("DOC text mismatch");
        }
        try (var doc = new XWPFDocument(); var output = Files.newOutputStream(directory.resolve("fixture.docx"))) {
            doc.createParagraph().createRun().setText(title);
            doc.createParagraph().setPageBreak(true);
            doc.getParagraphs().get(1).createRun().setText("第二页：阅读与作业");
            doc.write(output);
        }
        try (var deck = new HSLFSlideShow(); var output = Files.newOutputStream(directory.resolve("fixture.ppt"))) {
            for (int page = 1; page <= 2; page++) {
                var text = deck.createSlide().createTextBox();
                text.setAnchor(new Rectangle2D.Double(70, 70, 500, 80));
                text.setText(slideTitle + " · " + page);
            }
            deck.write(output);
        }
        try (var input = Files.newInputStream(directory.resolve("fixture.ppt"));
             var deck = new HSLFSlideShow(input)) {
            var text = (org.apache.poi.hslf.usermodel.HSLFTextBox) deck.getSlides().get(0).getShapes().get(0);
            if (!text.getText().contains(slideTitle)) throw new IllegalStateException("PPT text mismatch");
        }
        try (var deck = new XMLSlideShow(); var output = Files.newOutputStream(directory.resolve("fixture.pptx"))) {
            for (int page = 1; page <= 2; page++) {
                var text = deck.createSlide().createTextBox();
                text.setAnchor(new Rectangle2D.Double(70, 70, 500, 80));
                text.setText(slideTitle + " · " + page);
            }
            deck.write(output);
        }
        System.out.println("Generated Chinese DOC/DOCX/PPT/PPTX; reopened DOC and PPT and verified Chinese text");
    }
}
