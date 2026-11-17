/**
 * Stage fixture — multi-method class with comments between members.
 */
public class WeatherService {

    // getWeather — conflict candidate in merge tests
    public static void getWeather() {
        // Source implementation
        System.debug('source');
    }

    public static void getForecast() {
        /* block comment inside */
        System.debug('forecast');
    }

    public void getTemperature() {
        System.debug('temperature');
    }

    public static String greet(String name, Integer count) {
        return name + String.valueOf(count);
    }

    public static String greet(Decimal value) {
        return String.valueOf(value);
    }
}