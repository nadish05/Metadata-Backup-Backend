@RestResource(urlMapping='/demo/*')
global with sharing class Comprehensive extends BaseHandler implements IWorker, IRunnable {
    private Integer counter = 0;
    public static final String LABEL = 'Demo';

    global Comprehensive() {
        counter = 1;
    }

    public Comprehensive(String seed) {
        counter = Integer.valueOf(seed);
    }

    @AuraEnabled
  public static List<String>
    load(
        Map<String, Integer> flags,
        Set<Id> recordIds
    ) {
        return new List<String>();
    }

    @TestVisible
    private void helper() {
        // inline comment
    }

    public String label {
        get { return LABEL; }
        set { /* no-op */ }
    }

    public class InnerWorker {
        public void run() {
            System.debug('inner');
        }

        public void run(String mode) {
            System.debug(mode);
        }
    }
}